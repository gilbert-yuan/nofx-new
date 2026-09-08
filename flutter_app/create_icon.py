#!/usr/bin/env python3
"""
生成 NOFX 应用图标
需要安装: pip install pillow
"""

from PIL import Image, ImageDraw, ImageFont
import os

def create_icon(size, output_path):
    """创建指定尺寸的图标"""
    # 创建图像，使用渐变绿色背景
    img = Image.new('RGB', (size, size), '#16845b')
    draw = ImageDraw.Draw(img)

    # 绘制渐变背景
    for i in range(size):
        # 从深绿到浅绿的渐变
        ratio = i / size
        r = int(22 + (30 - 22) * ratio)
        g = int(132 + (180 - 132) * ratio)
        b = int(91 + (120 - 91) * ratio)
        color = (r, g, b)
        draw.line([(0, i), (size, i)], fill=color)

    # 计算尺寸比例
    padding = int(size * 0.15)
    chart_width = size - padding * 2
    chart_height = int(chart_width * 0.6)
    chart_y = int((size - chart_height) / 2)

    # 绘制 K 线图样式
    num_bars = 7
    bar_spacing = chart_width // num_bars
    bar_width = int(bar_spacing * 0.4)

    # K线数据（模拟上涨趋势）
    prices = [0.3, 0.5, 0.4, 0.6, 0.55, 0.7, 0.75]

    for i, price in enumerate(prices):
        x = padding + i * bar_spacing + bar_spacing // 2

        # 计算K线高度
        bar_height = int(chart_height * price)
        y_top = chart_y + chart_height - bar_height
        y_bottom = chart_y + chart_height

        # 绘制影线（细线）
        shadow_extend = int(bar_height * 0.2)
        draw.line([(x, y_top - shadow_extend), (x, y_bottom)],
                  fill='#ffffff', width=max(2, size // 100))

        # 绘制实体（矩形）
        rect_height = int(bar_height * 0.7)
        rect_y = y_bottom - rect_height
        rect_left = x - bar_width // 2
        rect_right = x + bar_width // 2

        # 阳线（绿色/白色）
        if i % 3 != 1:  # 大部分是阳线
            draw.rectangle([rect_left, rect_y, rect_right, y_bottom],
                          fill='#ffffff', outline='#ffffff')
        else:  # 少数阴线
            draw.rectangle([rect_left, rect_y, rect_right, y_bottom],
                          fill='#e8f5ef', outline='#ffffff')

    # 绘制上升趋势线
    line_points = []
    for i, price in enumerate(prices):
        x = padding + i * bar_spacing + bar_spacing // 2
        y = chart_y + chart_height - int(chart_height * price * 0.7)
        line_points.append((x, y))

    # 绘制趋势线
    for i in range(len(line_points) - 1):
        draw.line([line_points[i], line_points[i + 1]],
                  fill='#ffffff', width=max(3, size // 80))

    # 在趋势线上绘制小圆点
    dot_radius = max(4, size // 60)
    for point in line_points:
        draw.ellipse([point[0] - dot_radius, point[1] - dot_radius,
                     point[0] + dot_radius, point[1] + dot_radius],
                    fill='#ffffff', outline='#ffffff')

    # 添加圆角效果（可选）
    if size >= 512:
        # 为大图标添加圆角
        mask = Image.new('L', (size, size), 0)
        mask_draw = ImageDraw.Draw(mask)
        corner_radius = int(size * 0.2)
        mask_draw.rounded_rectangle([0, 0, size, size],
                                     radius=corner_radius,
                                     fill=255)

        # 应用圆角蒙版
        output = Image.new('RGB', (size, size), '#16845b')
        output.paste(img, (0, 0), mask)
        return output

    return img

def main():
    """生成所有尺寸的图标"""
    # 定义各种尺寸
    sizes = {
        'mipmap-mdpi': 48,
        'mipmap-hdpi': 72,
        'mipmap-xhdpi': 96,
        'mipmap-xxhdpi': 144,
        'mipmap-xxxhdpi': 192,
    }

    # 获取脚本所在目录
    script_dir = os.path.dirname(os.path.abspath(__file__))
    res_dir = os.path.join(script_dir, 'android', 'app', 'src', 'main', 'res')

    print("Generating NOFX app icons...")

    # 为每个尺寸生成图标
    for folder, size in sizes.items():
        folder_path = os.path.join(res_dir, folder)
        if not os.path.exists(folder_path):
            os.makedirs(folder_path)

        icon_path = os.path.join(folder_path, 'ic_launcher.png')
        icon = create_icon(size, icon_path)
        icon.save(icon_path, 'PNG')
        print(f"[OK] Generated {folder}/ic_launcher.png ({size}x{size})")

    # 生成高清预览图
    preview_path = os.path.join(script_dir, 'app_icon_preview.png')
    preview = create_icon(512, preview_path)
    preview.save(preview_path, 'PNG')
    print(f"\n[OK] Generated preview: app_icon_preview.png (512x512)")

    print("\nIcon generation completed!")
    print("Please rebuild APK to apply new icon.")

if __name__ == '__main__':
    main()
