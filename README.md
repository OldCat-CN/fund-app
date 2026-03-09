# 基金宝

一款功能丰富的开源基金管理工具，专为 Android 平台打造。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Vue](https://img.shields.io/badge/Vue-3.x-brightgreen.svg)
![Capacitor](https://img.shields.io/badge/Capacitor-7.x-blue.svg)
![Platform](https://img.shields.io/badge/Platform-Android-green.svg)
![Version](https://img.shields.io/badge/Version-1.9.0-orange.svg)

> 📖 **详细介绍**：[查看完整项目文档](./docs/ARTICLE.md)

## 功能特点

### 核心功能
- **实时估值** - 秒级刷新基金实时估值数据
- **自选管理** - 添加、删除、排序自选基金
- **持仓管理** - 记录持仓份额，自动计算收益
- **走势曲线** - 专业的分时/K线图表展示（当日、5日、月、季、年、3年）
- **基金详情** - 完整的基金信息展示
- **截图导入** - 支持支付宝/天天基金等平台截图识别导入

### AI 智能功能
- **AI智能日报** - 通义千问AI生成个性化投资日报
- **趋势预测** - 基于技术指标的趋势分析
- **持仓评分** - 综合评分系统（收益+风险+稳定性）
- **相关性分析** - 持仓基金相关性及风险分散度

### 分析工具
- **基金对比** - 多基金走势对比分析
- **回测模拟** - 定投/一次性买入历史回测
- **资产分析** - 持仓资产分布可视化
- **定投计算器** - 定投收益模拟计算
- **收益分析** - 夏普比率、最大回撤、年化收益等

### 数据查询
- **分红记录** - 历史分红数据查询
- **费率查询** - 申购/赎回/管理费率
- **基金公告** - 分红公告、报告通知
- **基金规模** - 资产规模变化追踪
- **同类基金** - 相似基金推荐对比

### 筛选排行
- **基金筛选** - 多维度筛选优质基金
- **基金经理** - 经理业绩排行榜
- **板块行情** - 各板块涨跌概览
- **全球指数** - A股/港股/美股/欧洲/亚洲指数实时行情

### 辅助功能
- **智能提醒** - 涨跌幅/净值预警提醒
- **收益报告** - 生成可分享的收益图片
- **投资日历** - 记录投资计划和事件
- **财经资讯** - 实时财经新闻推送
- **主题切换** - 浅色/深色主题自由切换
- **页面记忆** - 记住上次访问的页面

## 快速开始

### 下载安装

| 下载渠道 | 链接 | 备注 |
|---------|------|------|
| GitHub Releases | [下载](https://github.com/xiriovo/fund-app/releases) | 最新版本 |
| 123云盘 | [下载](https://www.123865.com/s/Tfksjv-0rThd) | 国内高速 |
| 蓝奏云 | [下载](https://wwbda.lanzn.com/ippf73hh019i) | 密码: `36mh` |

### 本地开发

```bash
# 克隆项目
git clone https://github.com/xiriovo/fund-app.git
cd fund-app

# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build
```

### Android APK 构建

```bash
# 构建 Web 并同步到 Android
npm run build
npx cap sync

# 命令行构建 Release 版本（需要 JDK 21）
cd android
./gradlew assembleRelease
```

APK 输出位置：
- Debug: `android/app/build/outputs/apk/debug/app-debug.apk`
- Release: `android/app/build/outputs/apk/release/app-release.apk`

## 技术栈

- **前端框架**：Vue 3 + TypeScript
- **构建工具**：Vite 7
- **UI 组件**：Vant 4 + Varlet 3
- **状态管理**：Pinia
- **图表绘制**：Canvas API（自定义实现）
- **移动打包**：Capacitor 7
- **路由管理**：Vue Router 4

## 项目结构

```
fund-app/
├── src/
│   ├── api/          # API 接口封装
│   ├── components/   # 通用组件
│   ├── views/        # 页面组件
│   ├── stores/       # Pinia 状态管理
│   ├── router/       # 路由配置
│   └── utils/        # 工具函数
├── android/          # Android 原生项目
└── public/           # 静态资源
```

## 免责声明

⚠️ **重要提示**

- 本工具仅供学习交流使用，不构成任何投资建议
- 基金估值数据仅供参考，以基金公司公布的净值为准
- 数据刷新有延迟，仅供学习和参考
- **投资有风险，理财需谨慎**
- 下载后请在 24 小时内删除

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。

## 贡献指南

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

## 赞助与交流

- **QQ**: 1708298587
- **telegram**: https://t.me/fundTreasure
- **GitHub Issues**: [提交问题](https://github.com/xiriovo/fund-app/issues)

## 致谢

感谢所有为本项目做出贡献的开发者！
