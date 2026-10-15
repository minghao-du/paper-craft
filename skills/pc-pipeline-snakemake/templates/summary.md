# Stage Summary: {stage_id} - {stage_name}

## 1. Executive Summary
- Status: Completed (Exit 0)
- Execution Time: {duration}
- Key Finding / Takeaway: {1-2 sentence core finding, quantitative metric, or processing outcome}

## 2. Attrition & Data Shape
| Metric | Count / Shape | Note |
| :--- | :--- | :--- |
| Inputs Received | {n_input} | Input samples or raw entities received |
| Filtered / Dropped | {n_dropped} | Attrition count and primary filter threshold |
| Output Dimensions | {n_rows} rows × {n_cols} cols | Cleaned data matrix scale and missingness |

## 3. Downstream Interface Contract
- Primary Output Path: `{relative_path_from_project_root}`
- Format: `{parquet/tsv/h5/pt}`
- Core Schema & Types:
  - `{col_A}` ({type}): {Description / value range}
  - `{col_B}` ({type}): {Description / categorical levels}
- Head Preview (First 2 Rows):
  ```text
  {compact_table_preview_first_two_rows}
  ```

## 4. Deliverables & Figures
- Figures for Manuscript:
  - `{relative_path_to_fig}`: {One-sentence caption explaining the scientific takeaway for manuscript inclusion}
- Anomalies / Warnings:
  - {None / expected boundary conditions, e.g., missing values imputed with median}
