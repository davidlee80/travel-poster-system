import argparse
from pathlib import Path

import pandas as pd


def format_cell(value) -> str:
    """格式化单元格内容，使其适合 Markdown 表格。"""
    if pd.isna(value):
        return ""

    if isinstance(value, pd.Timestamp):
        value = value.strftime("%Y-%m-%d %H:%M:%S")

    return (
        str(value)
        .replace("\\", "\\\\")
        .replace("|", "\\|")
        .replace("\r\n", "<br>")
        .replace("\n", "<br>")
        .replace("\r", "<br>")
    )


def excel_to_markdown(
    input_file: str,
    output_file: str | None = None,
    sheet_name: str | None = None,
):
    """将 Excel 文件转换为 Markdown。"""

    input_path = Path(input_file).resolve()

    if not input_path.exists():
        raise FileNotFoundError(f"文件不存在：{input_path}")

    if input_path.suffix.lower() not in {".xlsx", ".xls", ".xlsm"}:
        raise ValueError("仅支持 .xlsx、.xls 和 .xlsm 文件。")

    if output_file:
        output_path = Path(output_file).resolve()
    else:
        output_path = input_path.with_suffix(".md")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    # sheet_name=None 表示读取所有工作表
    if sheet_name:
        dataframe = pd.read_excel(input_path, sheet_name=sheet_name, dtype=object)
        sheets = {sheet_name: dataframe}
    else:
        sheets = pd.read_excel(input_path, sheet_name=None, dtype=object)

    markdown_parts = [f"# {input_path.stem}", ""]

    for name, dataframe in sheets.items():
        markdown_parts.append(f"## {name}")
        markdown_parts.append("")

        if dataframe.empty:
            markdown_parts.append("*该工作表为空。*")
            markdown_parts.append("")
            continue

        # 格式化列名
        dataframe.columns = [format_cell(column) for column in dataframe.columns]

        # 格式化单元格
        dataframe = dataframe.map(format_cell)

        markdown_table = dataframe.to_markdown(
            index=False,
            tablefmt="github",
            disable_numparse=True,
        )

        markdown_parts.append(markdown_table)
        markdown_parts.append("")

    output_path.write_text(
        "\n".join(markdown_parts),
        encoding="utf-8",
    )

    print(f"转换完成：{output_path}")
    print(f"共转换 {len(sheets)} 个工作表。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="将 Excel 文件转换为 Markdown 表格"
    )

    parser.add_argument(
        "input",
        help="输入的 Excel 文件",
    )

    parser.add_argument(
        "-o",
        "--output",
        help="输出的 Markdown 文件",
    )

    parser.add_argument(
        "-s",
        "--sheet",
        help="只转换指定名称的工作表，默认转换所有工作表",
    )

    args = parser.parse_args()

    try:
        excel_to_markdown(
            input_file=args.input,
            output_file=args.output,
            sheet_name=args.sheet,
        )
    except (FileNotFoundError, ValueError, ImportError) as error:
        print(f"错误：{error}")
    except Exception as error:
        print(f"转换失败：{error}")