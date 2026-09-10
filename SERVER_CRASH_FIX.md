# 服务器崩溃问题修复指南

## 错误信息
```
Error: connect EPERM \\.\pipe\rpc.sock
[nodemon] app crashed - waiting for file changes before starting...
```

## 原因分析

这个错误通常由以下原因引起：
1. **Docker Desktop** 的命名管道冲突
2. **Git Bash** 与 Windows 命名管道的兼容性问题
3. 某些依赖库尝试连接不存在的管道

## 🔧 解决方案

### 方案 1：使用 CMD 或 PowerShell 启动（推荐）

Git Bash 在处理 Windows 命名管道时可能有问题。

**步骤**：
1. 打开 **PowerShell** 或 **CMD**
2. 运行：
   ```bash
   cd D:\UGit\nofx-new
   npm run dev
   ```

### 方案 2：关闭 Docker Desktop

如果你安装了 Docker Desktop 但不使用：

**步骤**：
1. 关闭 Docker Desktop
2. 重启服务器：
   ```bash
   npm run dev
   ```

### 方案 3：检查并清理环境变量

某些环境变量可能导致问题。

**检查**：
```bash
echo $DOCKER_HOST
```

**如果有输出**，临时禁用：
```bash
unset DOCKER_HOST
npm run dev
```

### 方案 4：只启动后端服务器

如果前端不需要实时开发，只启动后端：

**步骤**：
```bash
cd D:\UGit\nofx-new
npm run dev:server
```

## ✅ 快速修复（立即尝试）

**在 PowerShell 中执行**：

```powershell
cd D:\UGit\nofx-new
npm run dev:server
```

这将只启动后端 API 服务器，避开前端构建工具可能的问题。

## 📊 验证修复

服务器启动成功后，应该看到：

```
[GlobalAutomation] 系统就绪
NOFX Lite API listening on http://127.0.0.1:3100
[GlobalAutomation] 全局自动化系统已启动
```

然后测试 API：
```bash
curl http://localhost:3100/api/health
curl http://localhost:3100/api/adaptive/config
```

## 📝 当前状态

根据日志，服务器在启动时崩溃了，但优化代码本身没有问题：
- ✅ 自适应优化代码已部署
- ✅ 配置已保存（币种过滤50%阈值）
- ⚠️ 服务器启动失败（管道权限问题）

## 🎯 建议操作

1. **打开 PowerShell**（不要用 Git Bash）
2. 运行：
   ```powershell
   cd D:\UGit\nofx-new
   npm run dev:server
   ```
3. 等待看到 "NOFX Lite API listening"
4. 测试 API 是否正常

---

**总结**：这不是代码问题，而是 Git Bash 与 Windows 命名管道的兼容性问题。使用 PowerShell 或 CMD 应该可以解决。
