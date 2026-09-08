# NOFX Python Qt 盯盘客户端

这是一个独立的 PySide6 Windows 桌面客户端，复用仓库现有 Node API，提供单币盯盘、K线 SQLite 持久化和 AI 分析。

## 功能

- 选择单个 Bybit USDT 合约盯盘
- 获取并保存 K线到本地 SQLite
- 查看最新价格和自绘K线图
- 调用 Node API 的单币 AI 分析
- 保存分析结果和历史记录到 SQLite
- 定时自动刷新 K线
- Windows 置顶、紧凑模式、无边框拖动
- 窗口透明度 30%-100% 可微调
- 鼠标移出窗口时自动降低透明度，移入后恢复
- Node API 不可用时读取本地 K线和历史分析缓存

## 安装

建议使用 Python 3.10 或更高版本：

```powershell
cd d:\UGit\nofx-new\python_app
python -m venv .venv
.venv\Scripts\activate
python -m pip install --upgrade pip
pip install -r requirements.txt
```

不需要安装 Visual Studio C++ 工具链。Python 的 `sqlite3` 是标准库，PySide6 通常通过 pip 安装预编译包。

## 启动

先启动现有 Node API：

```powershell
cd d:\UGit\nofx-new
npm run start
```

另开 PowerShell 启动 Python Qt：

```powershell
cd d:\UGit\nofx-new\python_app
.venv\Scripts\activate
python main.py
```

也可以通过环境变量指定 API 地址和 SQLite 目录：

```powershell
$env:NOFX_API_BASE = 'http://127.0.0.1:3000/api'
$env:NOFX_DATA_DIR = "$env:APPDATA\nofx-python-qt"
python main.py
```

## 数据库

默认数据库路径：

```text
%APPDATA%\nofx-python-qt\nofx_research.sqlite
```

表结构：

- `candles`：按币种、周期、开盘时间保存 K线
- `analyses`：保存 Node API 返回的完整 AI 分析 envelope
- `symbols`：保存币种目录缓存
- `settings`：保存当前币种、窗口和刷新设置

## 操作说明

1. 启动应用后选择币种、周期和K线数量。
2. 点击“刷新 K线”获取行情并写入 SQLite。
3. 点击“AI 分析”调用单币分析接口。
4. 勾选“自动刷新”按设置的秒数更新行情。
5. 勾选“鼠标移出降低透明度”后，鼠标离开窗口会降低透明度。
6. 勾选“紧凑悬浮窗”可以切换到适合桌面盯盘的小窗口。

## 注意

应用只做研究展示，不执行真实交易。AI 分析需要现有 Node API 正常运行，并且 Node 服务已经配置可用的 AI Provider。
