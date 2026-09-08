# NOFX Flutter 盯盘研究工作台

这是 NOFX 的 Flutter 盯盘研究工作台。应用直接连接交易所行情接口和 AI API，配置可在“策略设置”中修改；应用只做研究展示，不执行真实交易。

## 功能

- 直接从交易所获取合约目录和 K 线，直接调用 AI API 完成单币分析。
- 单币盯盘：选择合约、周期、K 线数量、刷新间隔和自动刷新。
- 手动刷新 K 线，调用单币 AI 分析，查看最新分析和历史分析。
- 交易所行情和 AI 分析结果写入本地 SQLite，重启后恢复当前币种、分析范围、刷新设置、K 线和分析历史。
- 网络接口不可用时使用本地 SQLite 中已保存的 K 线、币种目录和分析历史；没有可用缓存时提示数据不可用。
- Windows 支持置顶、悬浮小窗、无边框标题栏拖动、失焦透明度降低，以及 30%-100% 透明度调节。
- Web 和其他 Flutter 平台保留可编译能力，窗口控制在非 Windows 平台自动禁用。

## 本地数据库

Windows 使用 `sqflite_common_ffi` 创建 SQLite 文件 `nofx_research.sqlite`，文件位于系统的应用支持目录。数据库至少包含：

- `klines`：按 `symbol`、`interval`、`open_time` 持久化 K 线。
- `analyses`：持久化 AI 直连返回的分析结果。
- `settings`：恢复当前币种、交易所行情地址、AI API 地址、AI API Key、策略配置、自动刷新和窗口状态。
- `cache`：币种目录和最新分析缓存。

## 运行

在 Flutter 项目目录安装依赖并运行：

```powershell
cd flutter_app
flutter pub get
flutter run -d windows
```

如果 Windows 平台目录缺失：

```powershell
flutter create --platforms=windows .
```

## 验证

```powershell
dart format lib test
flutter analyze
flutter test
```

Windows 桌面构建还需要 Visual Studio 和 Desktop development with C++ 工具链；没有该工具链时不能声称 Windows build 成功。
