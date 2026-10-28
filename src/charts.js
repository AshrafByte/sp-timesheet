/*
 * Timesheet charts: SVG column charts drawn from plain data. No state and no
 * PluginAPI. app.js passes the data in and gets hover and select events back.
 * The build inlines this between core.js and app.js.
 */
const TimesheetCharts = (() => {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const GAP = 2; // surface gap between stacked segments
  const RADIUS = 4; // rounded data end; the base stays square
  const MAX_BAR = 24;
  const AXIS_W = 40;
  const PAD_TOP = 24; // room for the label over the tallest column
  let clipCount = 0;

  const svg = (tag, attrs = {}, ...children) => {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value != null && value !== false) node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  };

  // A column with a rounded top and a square base.
  const columnPath = (x, y, w, h) => {
    const r = Math.min(RADIUS, w / 2, h);
    return `M${x},${y + h}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h}Z`;
  };

  /**
   * Draws a column chart into `host`, replacing what was there.
   *
   * opts:
   *   width, height       size of the whole chart, x labels included (px)
   *   columns             [{ label, sublabel, total, segments: [{ key, ms, color }],
   *                          target, strong, muted, ariaLabel }]
   *   scale               { max, ticks } in ms
   *   formatTick(ms)      y-axis label
   *   capLabel            { index, text } for the one direct label, or null
   *   selected            index of the emphasized column, or -1 for none
   *   average             ms for the dashed average line, or null
   *   animate             grow the columns in
   *   onHover(i, anchor)  i = -1 when the pointer leaves; anchor = { x, y } in px
   *   onSelect(i)
   *
   * Returns { setHover(i) } so the caller can restore hover after a redraw.
   */
  const columnChart = (host, opts) => {
    const { width, height, columns, scale, selected = -1 } = opts;
    const hasSub = columns.some((c) => c.sublabel);
    const xBand = hasSub ? 38 : 24;
    const plotTop = PAD_TOP;
    const plotBottom = height - xBand;
    const plotH = plotBottom - plotTop;
    const slot = (width - AXIS_W) / columns.length;
    const barW = Math.max(6, Math.min(MAX_BAR, Math.round(slot * 0.5)));
    const y = (ms) => plotBottom - (scale.max > 0 ? (ms / scale.max) * plotH : 0);
    const centerOf = (i) => AXIS_W + slot * (i + 0.5);

    const root = svg('svg', {
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      class: 'ts-svg',
      role: 'group',
    });

    // Grid: solid hairlines, labels on the left.
    const grid = svg('g', { class: 'ts-grid', 'aria-hidden': 'true' });
    for (const tick of scale.ticks) {
      const ty = Math.round(y(tick)) + 0.5;
      grid.append(
        svg('line', { x1: AXIS_W, x2: width, y1: ty, y2: ty, class: tick === 0 ? 'ts-baseline' : 'ts-gridline' }),
        svg('text', { x: AXIS_W - 8, y: ty, class: 'ts-tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, opts.formatTick(tick)),
      );
    }
    root.append(grid);

    const columnsLayer = svg('g', { class: 'ts-columns' });
    const groups = columns.map((col, i) => {
      const cx = centerOf(i);
      const x = cx - barW / 2;
      const g = svg('g', {
        class: `ts-col${selected >= 0 && i !== selected ? ' is-dimmed' : ''}${opts.animate ? ' ts-grow' : ''}`,
        style: opts.animate ? `animation-delay:${i * 35}ms` : null,
        'aria-hidden': 'true',
      });
      // Hover band behind the column, shown while it's hovered.
      g.append(svg('rect', { class: 'ts-col-band', x: AXIS_W + slot * i + 2, y: plotTop - 8, width: slot - 4, height: plotH + 8, rx: 6 }));

      if (col.total > 0) {
        const top = Math.min(y(col.total), plotBottom - 2); // keep tiny totals visible
        const clipId = `ts-clip-${++clipCount}`;
        g.append(svg('clipPath', { id: clipId }, svg('path', { d: columnPath(x, top, barW, plotBottom - top) })));
        const stack = svg('g', { 'clip-path': `url(#${clipId})` });
        let base = plotBottom;
        col.segments.forEach((seg, s) => {
          const h = (seg.ms / col.total) * (plotBottom - top);
          const gap = s > 0 && h > GAP + 1 ? GAP : 0;
          if (h - gap > 0.25) {
            stack.append(svg('rect', { x, y: base - h, width: barW, height: h - gap, fill: seg.color }));
          }
          base -= h;
        });
        g.append(stack);
      }
      if (col.target > 0 && col.target <= scale.max) {
        const ty = Math.round(y(col.target)) + 0.5;
        g.append(svg('line', { class: 'ts-target-tick', x1: x - 5, x2: x + barW + 5, y1: ty, y2: ty }));
      }
      columnsLayer.append(g);
      return g;
    });
    root.append(columnsLayer);

    if (opts.average > 0) {
      const ay = Math.round(y(opts.average)) + 0.5;
      root.append(svg('line', { class: 'ts-avg-line', x1: AXIS_W, x2: width, y1: ay, y2: ay, 'aria-hidden': 'true' }));
    }

    if (opts.capLabel && columns[opts.capLabel.index]) {
      const col = columns[opts.capLabel.index];
      root.append(svg('text', {
        class: 'ts-cap',
        x: centerOf(opts.capLabel.index),
        y: Math.min(y(col.total), plotBottom) - 8,
        'text-anchor': 'middle',
        'aria-hidden': 'true',
      }, opts.capLabel.text));
    }

    // X labels.
    const labels = svg('g', { 'aria-hidden': 'true' });
    columns.forEach((col, i) => {
      if (!col.label) return;
      const cls = `ts-xlabel${col.strong ? ' is-strong' : ''}${col.muted ? ' is-muted' : ''}`;
      labels.append(svg('text', { class: cls, x: centerOf(i), y: plotBottom + 16, 'text-anchor': 'middle' }, col.label));
      if (col.sublabel) {
        labels.append(svg('text', { class: `${cls} ts-xsub`, x: centerOf(i), y: plotBottom + 31, 'text-anchor': 'middle' }, col.sublabel));
      }
    });
    root.append(labels);

    // Hit targets: the whole slot, taller than the column itself.
    // A tap selects; the tooltip is for mouse hover and keyboard focus, where
    // it doesn't sit under a finger or over the chart after the tap.
    let hovered = -1;
    let lastPointer = '';
    const setHover = (i) => {
      if (hovered >= 0 && groups[hovered]) groups[hovered].classList.remove('is-hover');
      hovered = i;
      if (i >= 0 && groups[i]) groups[i].classList.add('is-hover');
    };
    const anchorOf = (i) => ({ x: centerOf(i), y: columns[i].total > 0 ? y(columns[i].total) : plotBottom });
    const hits = columns.map((col, i) => {
      const hit = svg('rect', {
        class: 'ts-hit',
        x: AXIS_W + slot * i,
        y: 0,
        width: slot,
        height,
        tabindex: '0',
        role: 'button',
        'aria-label': col.ariaLabel,
        'aria-pressed': selected === i ? 'true' : 'false',
      });
      const hover = () => {
        setHover(i);
        if (opts.onHover) opts.onHover(i, anchorOf(i));
      };
      hit.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType; });
      hit.addEventListener('pointerenter', (e) => {
        lastPointer = e.pointerType;
        if (e.pointerType !== 'touch') hover();
      });
      hit.addEventListener('focus', () => {
        if (lastPointer !== 'touch') hover();
      });
      hit.addEventListener('click', () => opts.onSelect && opts.onSelect(i));
      hit.addEventListener('keydown', (e) => {
        const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (step) {
          e.preventDefault();
          const next = hits[Math.max(0, Math.min(hits.length - 1, i + step))];
          next.focus();
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (opts.onSelect) opts.onSelect(i);
        }
      });
      return hit;
    });
    const leave = () => {
      setHover(-1);
      if (opts.onHover) opts.onHover(-1, null);
    };
    hits.forEach((hit) => hit.addEventListener('blur', (e) => {
      if (!hits.includes(e.relatedTarget)) leave();
    }));
    root.addEventListener('pointerleave', leave);
    root.append(svg('g', { class: 'ts-hits' }, hits));

    host.replaceChildren(root);
    return {
      // Restores a hover (and its tooltip) after a redraw.
      setHover: (i) => {
        setHover(i);
        if (i >= 0 && columns[i] && opts.onHover) opts.onHover(i, anchorOf(i));
      },
      focus: (i) => hits[i] && hits[i].focus(),
    };
  };

  return { columnChart };
})();
