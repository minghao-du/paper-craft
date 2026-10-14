---
name: pc-review-plot
description: Review Python data visualization code (matplotlib, seaborn, altair, plotly) for proportional ink, accessibility, and publication standards.
disable-model-invocation: true
---

# /pc-review-plot

Review plotting and visualization code in Python against principles of publication-quality figure design (e.g., Claus Wilke's *Fundamentals of Data Visualization*).

## Review Checklist

### 1. Proportional Ink & Data Integrity
- **Bar charts must start at zero**: Never truncate the value axis on linear bar plots. Flag any nonzero `ylim` on bar charts.
- **Proportional element size**: Bubble areas, slice angles, and shaded regions must scale strictly with the underlying quantity, not the radius or linear dimension squared.
- **Log scales**: Ensure logarithmic scales are explicitly labeled and justified by dynamic range across orders of magnitude.
- **Avoid dual y-axes**: Flag independent twin axes (`ax.twinx()`), which allow arbitrary scaling and mislead comparisons. Suggest faceted subplots instead.

### 2. Chart Type Alignment
- **Pie charts**: Avoid pie charts with more than 3–4 slices; replace with sorted horizontal bar charts.
- **Stacked bars**: Avoid stacked bars for comparing sub-categories across groups (baseline shifts make comparing upper segments difficult). Use grouped bars or small multiples.
- **Gratuitous 3D**: Flag any 3D projection or angled charts that introduce foreshortening distortion.
- **Line plots**: Connect only sequential, continuous, or temporal data. Do not connect unordered categorical levels with lines.

### 3. Minimal Design & Layout
- Remove chartjunk: eliminate heavy dark gridlines, redundant borders, and decorative backgrounds.
- Use light gray or muted perpendicular gridlines only when precise coordinate readout is necessary.
- Despine plots: drop top and right box spines where they do not carry tick marks.
- Place legends outside the plotting area or label series directly at line ends.

### 4. Color Selection & Accessibility
- **Perceptually uniform colormaps**: Prohibit `jet`, `rainbow`, and non-uniform color progressions. Require `viridis`, `plasma`, `magma`, `cividis`, or `inferno`.
- **Colorblind accessibility**: Avoid red/green contrasting pairs for critical distinctions.
- **Palette semantics**:
  - Categorical data: qualitative palettes with ≤6–8 distinguishable hues.
  - Continuous data: sequential palettes.
  - Centered data (log-fold change, correlation, divergence around zero): diverging palettes with neutral midpoint.

### 5. Multi-Panel & Publication Hygiene
- Shared subplots must share axis limits (`sharex=True`, `sharey=True`) when comparing equivalent metrics across conditions.
- Consistent panel labeling (`A`, `B`, `C` in bold, uniform alignment).
- Axes must include variable names and explicit measurement units.
- Titles should state the finding rather than describe the plot type ("Treatment reduces latency" vs "Plot of latency").
- Ensure font sizes remain legible at target column width (single-column: ~85mm, double-column: ~170mm).

## Output Format

1. **Critical Flaws**: Misleading scales, truncated bars, dual axes, non-accessible colormaps.
2. **Design Improvements**: Alignment, despining, legend positioning, typography.
3. **Refactored Code**: Concrete Python code snippets using the author's plotting library implementing the recommendations.
