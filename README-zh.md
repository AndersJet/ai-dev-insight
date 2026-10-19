<div align="center">

<img src="apps/web/src/assets/brand/ai-dev-insight-icon.png" width="80" height="80" alt="AI Dev Insight">

# AI Dev Insight

社区版本 **1.0.0**。

可自主部署的 Trae 使用分析平台：团队采纳、Token 用量、会话复盘与项目观测。

[English](README.md) · **简体中文** · [构建与部署](docs/build.md) · [开发文档](DEVELOP.md)

</div>

![使用合成数据的产品预览](docs/images/product-overview.png)

## 功能

- 通过 Trae 插件采集 Hook 事件和 Git 项目元数据
- 查看个人用量、会话内容与 Token 能效分析材料
- 维护部门、成员、采纳进度和仓库归属分类
- 分别表达实际观测、可选的官方用量和估算，未知不当作零
- 在服务端执行系统管理员、组织管理员、部门管理员和成员的访问边界

预览图使用合成数据。官方用量接口默认关闭，需要部署者自己的供应商凭据；核心平台的编译与运行不依赖维护者的企业账号。

## 从源码编译

需要 Node.js 24、pnpm 10.33.0 和 Git。数据库测试与镜像构建另需 Docker。

```sh
git clone https://github.com/AndersJet/ai-dev-insight.git
cd ai-dev-insight
pnpm install --frozen-lockfile
make test
pnpm build
```

默认从公共 npm 安装，不需要维护者的私有依赖源、镜像仓库或 CI 权限。

构建结果包括 Web、API/Collector/Worker、原生 Hook 材料与 `trae-plugin/dist/adi-project-tracker-1.0.0.vsix`。四镜像构建、离线包和首次启动见[构建与部署说明](docs/build.md)。

## 本地运行

先准备 PostgreSQL 18、独立空应用 schema 和所需扩展，再配置数据库连接与部署管理员：

```sh
cp .env.example .env
# 编辑 ADI_DATABASE_URL、ADI_ADMIN_EMAIL、ADI_ADMIN_PASSWORD。
make dev
# Web：http://127.0.0.1:4181
make stop
```

完整的数据库 Compose 与环境配置步骤见 [DEVELOP.md](DEVELOP.md)。填写后的 `.env` 不进入 Git。

管理员先创建部门，成员再将[插件](trae-plugin/README.md)连接到自己的平台并注册或登录。默认 `ADI_EMAIL_DOMAINS` 留空，允许任意合法邮箱域；可配置逗号分隔的白名单。当前不验证邮箱所有权。

## 权限与数据

| 角色 | 管理与统计 | 会话内容 |
| --- | --- | --- |
| 系统超级管理员 | 全部部门与成员 | 全员 |
| 组织管理员 | 全部部门与成员 | 仅本人 |
| 部门管理员 | 获授权部门 | 仅本人 |
| 普通员工 | 本人范围 | 仅本人 |

Hook 事件可能包含提示词、回答、工具输入/输出和工作区信息；Git 观测读取元数据，不读取仓库源码。团队启用前请阅读[数据与隐私说明](docs/privacy.md)。

服务容器面向 Linux amd64/arm64；本地原生采集包含 macOS/Windows 路径，Linux Remote SSH 工作区使用独立助手。具体 IDE 和设备需要按同一构建单独验收，浏览器或进程测试不代替真机验证。

## 参与与反馈

问题与需求使用 [GitHub Issues](https://github.com/AndersJet/ai-dev-insight/issues)。提交前阅读[贡献说明](CONTRIBUTING.md)和[安全说明](SECURITY.md)，不要上传真实凭据、个人安装包或会话原文。

## 许可证

项目原创代码采用 [Apache-2.0](LICENSE)。第三方组件保留各自许可，详见 [NOTICE](NOTICE)、[依赖声明](THIRD_PARTY_NOTICES.md)和[完整许可材料](THIRD_PARTY_LICENSES.txt)。
