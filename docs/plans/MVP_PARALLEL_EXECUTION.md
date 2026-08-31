# MVP 并行开发执行计划

> 生成时间: 2026-08-31
> 目标: 并行推进 MVP 六周计划全部工作，满足发布标准

## 当前基线（来自代码验证）

- ✅ Media Provider: 真实（Windows GSMTC API）
- ✅ Focus Provider: 真实（Windows Focus Assist API）
- ❌ Download Provider: 纯模拟（setInterval）
- ❌ 5 个 Provider 虚假声明 available（Update/Git/Docker/npm/Download）
- ✅ System Performance: 真实（sysinfo crate）
- ✅ Clipboard: 真实
- ✅ 调度器: 有测试，有 15 秒交替逻辑
- ✅ 托盘/自启动/设置: 已实现

## MVP 发布标准（来自 MVP_LAUNCH_PLAN.md）

1. 安装、启动、从托盘恢复、遵守保存的偏好
2. Media/Download/Focus 有验证的实时或真实 fallback 行为
3. **当 Provider 报告不可用/不支持/降级时，没有任何状态声称是实时的**
4. 手动选择和自动返回行为可预测
5. 全屏避让、锁定位置、始终浮动偏好按描述工作
6. TypeScript/Vitest/QA/Rust 检查通过
7. 至少 3 名测试者完成验证会话并记录发现

## 并行工作流

### Workstream A: Provider 诚实性修复（P0 阻断项）
- 文件: `src/providers/impl/real/real{Download,Update,Git,Docker,Npm}Provider.ts`
- 改动: capability.support 从 "available" 改为 "unsupported"
- 同步更新对应测试
- 验证: `npm run test:vitest` 通过

### Workstream B: 真实 Download Provider
- Rust: 用 `notify` crate 监控 `~/Downloads` 目录变化
- 前端: 接收真实下载事件，显示真实状态
- 文件: `src-tauri/src/commands/system.rs`, `src/providers/impl/real/realDownloadProvider.ts`
- 验证: 真实下载时 bar 显示真实状态

### Workstream C: MVP 调度器与显示策略测试
- 基于 MVP_LAUNCH_PLAN.md 的显示策略表编写测试
- 覆盖: 手动选择、下载完成/失败、专注完成、媒体交替、不可用源、全屏
- 文件: `src/state/desktopStatusScheduler.test.ts` 或新文件
- 验证: 每个显示规则有对应测试

### Workstream D: Windows 外壳验证与加固
- 验证托盘、自启动、设置持久化、全屏避让
- 文件: `src-tauri/src/lib.rs`, `src-tauri/src/tray.rs`, `src/features/desktop/`
- 验证: MVP 发布标准第 1、5 条满足

### Workstream E: 场景矩阵与文档
- W1 交付物: 三状态的源/显示/过期/动作规则
- 场景矩阵: 正常/空/不可用/完成/失败
- 文件: `docs/product/MVP_SCENARIO_MATRIX.md`
- 验证: 团队能描述每个 MVP 场景下 bar 显示什么

## 依赖关系

```
A (Provider 诚实性) ──┬──> C (调度器测试，需要 fallback 行为正确)
                      │
B (Download Provider) ─┴──> C (需要真实 download 状态测试)
                      │
D (外壳加固) ──────────────> 独立
                      │
E (文档) ──────────────────> 独立
```

## 执行顺序

1. 并行启动: A, B, D, E
2. A 和 B 完成后: 启动 C
3. 全部完成后: 运行完整 QA 门禁
4. MVP 发布标准检查清单验证
