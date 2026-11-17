import { useEffect, useRef } from 'react';
import Plotly from 'plotly.js-dist-min';

export default function PlotFigure({ data, layout, className = '', onClick }) {
  const container = useRef(null);
  useEffect(() => {
    const element = container.current;
    Plotly.react(element, data, {
      ...layout,
      autosize: true,
      paper_bgcolor: '#ffffff',
      plot_bgcolor: '#ffffff',
      font: { family: 'Arial, Helvetica, sans-serif', size: 11, color: '#5b636a' },
      margin: layout.margin ?? { l: 56, r: 18, t: 15, b: 56 },
    }, { responsive: true, displaylogo: false }).then(() => {
      if (onClick) element.on('plotly_click', onClick);
    });
    const observer = new ResizeObserver(() => Plotly.Plots.resize(element));
    observer.observe(element);
    return () => { observer.disconnect(); Plotly.purge(element); };
  }, [data, layout, onClick]);
  return <div ref={container} className={`plot-figure ${className}`} />;
}
