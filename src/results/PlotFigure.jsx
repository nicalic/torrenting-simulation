import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import Plotly from "plotly.js-dist-min";

const PlotFigure = forwardRef(function PlotFigure(
  { data, layout, className = "", onClick },
  ref,
) {
  const container = useRef(null);
  useImperativeHandle(
    ref,
    () => ({
      restyle: (update, traces) =>
        Plotly.restyle(container.current, update, traces),
    }),
    [],
  );
  useEffect(() => {
    const element = container.current;
    const observer = new ResizeObserver(() => Plotly.Plots.resize(element));
    observer.observe(element);
    return () => {
      observer.disconnect();
      Plotly.purge(element);
    };
  }, []);
  useEffect(() => {
    const element = container.current;
    Plotly.react(
      element,
      data,
      {
        ...layout,
        autosize: true,
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
        font: {
          family: "Arial, Helvetica, sans-serif",
          size: 11,
          color: "#5b636a",
        },
        margin: layout.margin ?? { l: 56, r: 18, t: 15, b: 56 },
      },
      { responsive: true, displaylogo: false },
    );
  }, [data, layout]);
  useEffect(() => {
    const element = container.current;
    if (onClick) element.on("plotly_click", onClick);
    return () => {
      if (onClick) element.removeListener("plotly_click", onClick);
    };
  }, [onClick]);
  return <div ref={container} className={`plot-figure ${className}`} />;
});

export default PlotFigure;
