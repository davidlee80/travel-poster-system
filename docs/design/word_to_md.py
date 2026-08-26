import argparse
import shutil
import subprocess
from pathlib import Path


def word_to_markdown(input_file: str, output_file: str | None = None):
    """将 DOCX 文件转换为 Markdown。"""

    if shutil.which("pandoc") is None:
        raise RuntimeError("未找到 Pandoc，请先安装 Pandoc。")

    input_path = Path(input_file).resolve()

    if not input_path.exists():
        raise FileNotFoundError(f"文件不存在：{input_path}")

    if input_path.suffix.lower() != ".docx":
        raise ValueError("目前仅支持 .docx 文件，不支持旧版 .doc 文件。")

    if output_file:
        output_path = Path(output_file).resolve()
    else:
        output_path = input_path.with_suffix(".md")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    # 图片将保存到“文件名_media”目录
    media_dir = output_path.parent / f"{output_path.stem}_media"

    command = [
        "pandoc",
        str(input_path),
        "--from=docx",
        "--to=gfm",
        "--wrap=none",
        f"--extract-media={media_dir}",
        "--output",
        str(output_path),
    ]

    subprocess.run(command, check=True)

    print(f"转换完成：{output_path}")
    if media_dir.exists():
        print(f"图片目录：{media_dir}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="将 Word DOCX 文件转换为 Markdown")
    parser.add_argument("input", help="输入的 DOCX 文件")
    parser.add_argument("-o", "--output", help="输出的 Markdown 文件")

    args = parser.parse_args()

    try:
        word_to_markdown(args.input, args.output)
    except (FileNotFoundError, ValueError, RuntimeError) as error:
        print(f"错误：{error}")
    except subprocess.CalledProcessError as error:
        print(f"Pandoc 转换失败，退出码：{error.returncode}")