# ai-dev-insight 手工离线部署

> 本文说明镜像导出、配置字段、数据集切换和升级时的数据保护边界。日常首装、升级和 recover 以 [运维入口](README.md) 为准。

## 数据库备份和恢复

新升级入口在停止应用写入后，保存数据库逻辑备份、私有卷、配置和固定到原 Image ID 的 Compose 快照。`.complete` 和摘要只证明备份写出完整，不证明恢复成功。

`recover` 继续同版本向前升级，不自动恢复旧数据库。需要回退数据库时，先隔离目标并停止全部写入者，保留最新独立 cleanup journal 和原凭据密钥；使用现有 `recovery-cli` / `recovery-access-cli` 的检查点、清理重放、身份审核与显式开放流程。操作参数见 `deploy/product/recovery.env.example`，实际命令先查看对应 CLI 的帮助。不得直接恢复旧 DB 后启动服务，避免让已删除内容或旧凭据重新生效。灾备、异机备份和恢复时间另行验证。

目标：联网机器生成一个离线包，传到 Linux 服务器，修改 `.env`，执行 `docker-compose up -d`。不需要在服务器安装 Node、pnpm、Git 或访问 Harbor。

本目录包含四个应用镜像和 PostgreSQL 18.6。正常运行时有 **5 个常驻容器**：web、api、collector、worker、postgres。另有 **2 个一次性任务**：prepare-storage 准备持久卷权限，initialize 迁移数据库并同步管理员；它们复用 API 镜像，成功后退出，不需要额外镜像。

## 文件与数据

| 文件 | 用途 |
| --- | --- |
| `export-images.sh` | 拉取已发布版本，或用 `--local` 核验本地四应用候选；生成镜像 tar 和完整离线包 |
| `docker-compose.yml` | 一个 Compose 管理数据库、应用和初始化依赖；所有镜像 `pull_policy: never` |
| `.env.example` / `.env` | 空配置模板 / 当前机器的私有配置；生成包只复制空模板 |
| `postgres-init.sql` | 新数据库创建 adi_app 与 public.btree_gist、public.pg_trgm |
| `load-images.sh` | 离线服务器校验文件摘要、导入镜像、核对架构和 Image ID |
| `backup.sh` | 应用停止后备份数据库、密钥、清理 journal 和配置 |
| `lib.sh` | 脚本共享函数，需一起上传 |
| `images.tar` / `images.manifest` / `SHA256SUMS` | 打包时生成：镜像、来源与内容 ID 清单、文件校验值 |

仓库、产品镜像和新离线发行包统一使用 `ai-dev-insight`。已有部署的 Compose 项目名及命名卷是运行时身份，升级时显式保留并合并现场配置；新镜像名称不自动迁移已有卷。

数据库、账号采集凭据密钥、cleanup journal 放在独立命名卷中。新部署 Compose 项目名默认为 `ai-dev-insight`，由 `.env` 的 `COMPOSE_PROJECT_NAME` 固定，换目录不会生成另一套卷。已有部署升级时保持原项目名（例如 `trae-hooks-manual`）和原卷绑定，参见[重命名后的升级兼容](#rename-upgrade)。不要同时启动该项目的第二套副本，不要使用 `docker-compose down -v`。旧的 `-p adi` 或 `adi-db` 部署并不属于本项目，不能直接接管其卷或数据。

## 1. 社区镜像的版本身份

社区版本地交付以经过测试、审阅的完整提交 SHA 为身份，不自动发布或更新仓库 latest。四应用镜像须包含相同的 `org.opencontainers.image.revision` 标识，导出时同时核对架构与内容 ID。

PostgreSQL 固定为仓库采用的 `18.6` manifest digest，不跟随数据库 latest。包内应用重标记为 `ai-dev-insight-offline-api:latest` 等，并保留完整 SHA 标签；这里的本地 latest 只供已校验的离线 Compose 使用，不证明仓库上传或部署验收。

## 2. 联网机器生成离线包

在源码仓库根目录运行 `make images`，可用 `IMAGE_PLATFORM=linux/arm64` 指定目标架构。构建需要干净的已提交源码，默认使用公共 npm，不需要私有 CI 或镜像发布账号。详细入口见源码仓库的 `docs/build.md`。

进入本目录，从本地已构建镜像生成包：

```sh
cd deploy/manual
revision=$(git rev-parse HEAD)
sh export-images.sh --local --tag "$revision" --kind install
sh export-images.sh --local --tag "$revision" --kind upgrade
```

arm64 目标机还需在两条导出命令中指定 `--platform linux/arm64`，与构建架构保持一致。install 包额外取得固定 PostgreSQL 镜像，upgrade 包只使用四应用。

若部署者自行维护镜像仓库，可显式用 `--image-prefix registry.example.org/team/ai-dev-insight --tag 完整提交SHA` 从该仓库拉取。该仓库须真实存在且已具备所选架构；这里的地址只是语法示例。没有维护者私有仓库默认值。拉取失败、架构不符、不同提交或导出失败均非零退出，不生成成功包。

### 从本地已构建候选导出

新源码尚未发布到镜像仓库时，可显式使用 `--local`。先完成候选版本的测试和审阅，再按该版本的完整提交 SHA 构建四张目标架构镜像；每张都必须有相同的 `org.opencontainers.image.revision` 完整 SHA 标签。下面的前缀替换为实际构建使用的前缀：

```sh
bash export-images.sh --local --tag <40位完整SHA> \
  --image-prefix candidate.local/work/ai-dev-insight --platform linux/amd64
```

脚本仅检查本地 `<前缀>-api:<SHA>`、`-collector:<SHA>`、`-worker:<SHA>`、`-web:<SHA>`，复核两次内容 ID、架构和 revision。缺少镜像、标签不符或检查期间身份改变会失败。该模式不构建、不拉取四应用，也不登录或推送镜像仓库；不能用 `latest`、短 SHA 或未带 revision 的旧镜像替代新候选。

install 包仍需通过 Docker 取得固定 PostgreSQL 18.6 镜像；upgrade 包只使用四个应用镜像。父 index 摘要及其唯一匹配的 amd64、arm64/v8 子 manifest 摘要一并固定在 lib.sh，打包时按子摘要拉取并核验实际架构，不再额外调用 Buildx 直连 Docker Hub 查询索引。原始父索引保存在 scripts/test/fixtures/postgres-18.6-index.json，测试校验其 SHA256 与父摘要一致，并核对两平台映射；以后升级 PostgreSQL 时须一起更新父摘要、子摘要及该证据。不接受自选 PostgreSQL 镜像或浮动 tag，不覆盖已缓存的另一架构父摘要。镜像下载继续沿用 Docker 的既有仓库和加速配置。

包仍使用相同的 `load-images.sh` 导入格式；`images.manifest` 的 PostgreSQL source 记录实际子摘要，并用 `postgres_parent` 注释记录固定父摘要。本地导出只说明候选镜像被核验和打包，不代表已发布、已在目标 Linux 部署，或已通过 Trae 真机验收。

输出示例：

```text
offline/
  ai-dev-insight-<12位SHA>-amd64-<UTC时间>/
    images.tar
    images.manifest
    SHA256SUMS
    docker-compose.yml
    .env                 # 空模板，不是联网机器的私有配置
    .env.example
    postgres-init.sql
    load-images.sh
    backup.sh
    lib.sh
    export-images.sh
    README.md
  ai-dev-insight-<12位SHA>-amd64-<UTC时间>.tar.gz
  ai-dev-insight-<12位SHA>-amd64-<UTC时间>.tar.gz.sha256
```

传输 `.tar.gz` 和相应 `.sha256` 两个文件即可；全部部署文件已在包内。首次部署不需要自己另收集 SQL 或脚本。请勿在打包期间并行运行另一份打包目录或手工改同名本地镜像标签。

## 3. 服务器解包与导入

适用 **新 PostgreSQL 数据目录**；旧 SQLite、旧 schema 账本、现有非空业务 schema 或其他项目的卷不走这条首装路径。目标机需 Docker Engine、Compose V2、Bash、tar，以及 SHA256 校验工具。数据盘建议由运维提供独立容量与异机备份位置；卷实际位于 Docker 数据根，不能把部署目录所在盘的空间当作数据库预算。

上传到服务器的工作目录，然后校验外层包。以下文件名替换为本次实际文件名：

```sh
# Linux，校验结果应显示 OK
sha256sum -c ai-dev-insight-<实际名称>.tar.gz.sha256
tar -xzf ai-dev-insight-<实际名称>.tar.gz
cd ai-dev-insight-<实际名称>
bash load-images.sh
```

**应看到：**内层所有校验 OK、Docker 导入完成、`Five images loaded and verified`。脚本导入前检查目标 Docker 架构，导入后检查全部 Image ID 与架构。不要跳过失败继续启动。

## 4. 更新 .env

```sh
chmod 600 .env
nano .env
```

必须填写以下配置：

| 配置 | 怎么填 |
| --- | --- |
| ADI_PG_ADMIN_PASSWORD | 数据库管理角色独立密码 |
| ADI_APP_DB_PASSWORD | 应用角色独立密码；直接组成URI，使用下面生成的十六进制值 |
| ADI_ADMIN_EMAIL | 配置超级管理员真实企业邮箱 |
| ADI_ADMIN_PASSWORD | 配置管理员密码，12–128字符；建议独立生成 |
| ADI_EMAIL_DOMAINS | 留空允许任意合法邮箱域；配置白名单时以逗号分隔，并包含管理员邮箱域 |
| ADI_WEB_ORIGIN | 员工实际浏览器访问的协议、主机和端口，不带路径或末尾斜线 |
| ADI_PUBLIC_COLLECTOR_URL | 员工实际能访问的 `/hooks` 地址，可与 Web 同源 |

分别执行三次以下命令，复制**不同**的结果作为三个密码；不要把实际值提交到 Git：

```sh
openssl rand -hex 24
```

这样生成48位十六进制密码，满足管理员要求，也避免数据库 URI 的特殊字符编码问题。不要填 `<密码>` 等占位文字。若改用其他应用密码，必须保证组成的 PostgreSQL URI 正确，尤其 `% @ : / # ? $` 等字符；推荐沿用十六进制。

直接 HTTP 访问示例，假设服务器域名为 `server.example.org`：

```dotenv
ADI_WEB_ORIGIN=http://server.example.org:4181
ADI_PUBLIC_COLLECTOR_URL=http://server.example.org:4181/hooks
ADI_WEB_BIND_ADDRESS=0.0.0.0
ADI_WEB_HOST_PORT=4181
```

默认将 web 的4181端口开放到服务器网卡；按现场策略允许员工网段访问。API 和 PostgreSQL 不对外暴露；collector4186仅绑定本机，员工通过 Web `/hooks` 上报。

若已有本机 HTTPS 入口代理，将两个公开地址改为实际 `https://域名` 和 `https://域名/hooks`，设置 `ADI_WEB_BIND_ADDRESS=127.0.0.1`，入口转发到 `127.0.0.1:4181`。保留 `/api/` 与 `/hooks` 路径、合适的请求体/超时，不缓存个人包或在线安装响应，不记录 Authorization 或私有响应正文。容器内的代理不能把自己的127.0.0.1当成宿主机。此包不自动配置DNS、证书或现场入口代理。

保持 `ADI_USAGE_ENABLED=false`、`ADI_USAGE_STOP_WINDOW_ENABLED=false`，有官方凭据和专项验收后再启用。不要把服务器配置文件当 shell 脚本 `source`。

## 5. 启动与验收

从该目录执行，先只做配置校验，不输出带密码的展开配置：

```sh
docker-compose config --quiet
docker-compose up -d
docker-compose ps -a
docker-compose logs --tail 80 initialize
```

启动依赖自动完成：postgres健康 → prepare-storage成功 → initialize成功 → 后端运行 → api健康 → web启动。没有外部网络或目录需要手工创建。`pull_policy: never` 防止离线机器尝试下载镜像。

API 在 Worker 发布第一份完整会话列表快照并完成元数据预热后才监听。API 健康检查的启动宽限为 120 秒，为首份发布的 60 秒预算及随后完整元数据 warm 留出余量；实际大规模冷启动仍须独立验证。提前就绪会立即正常判定健康。宽限后仍沿用每 10 秒检查、2 秒探针期限、连续 3 次失败判定；数据库普通 SQL 5 秒期限与原 CPU/内存配额不变。API 长期等待时应检查 Worker、发布快照与初始化结果，不能绕过 warm 或将健康等待当作业务通过。

**应看到：**prepare-storage与initialize为 `Exited (0)`；postgres、api、collector、web为 `healthy`；worker为 `running`。`up -d`返回并不代表健康就绪，可用 `docker-compose up -d --wait --wait-timeout 180` 等待。worker没有容器健康探针，必须另验任务心跳。

```sh
curl --fail --silent --show-error http://127.0.0.1:4181/healthz
curl --fail --silent --show-error http://127.0.0.1:4186/readyz
```

接着从员工电脑打开实际 Web 地址，用配置管理员登录，核对角色权限、注册/个人凭据、测试账号的真实 Hook 安装与上报、持久化、派生和后台心跳。`/hooks` HTTP200是放行，不是事件已入库；容器运行、端点健康、真实业务验收分开记录。保持私有日志，分享前脱敏。

常见失败：

- `No such image`：未成功导入、错误架构，或运行了另一份Compose。重新检查load-images的结果。
- prepare-storage失败：目标Docker/卷权限不支持；看该任务日志，不先启动应用。
- initialize失败：检查数据库/schema权限、管理员邮箱域/密码和密钥；修正后按升级章节强制重新运行，不清库重试。
- 浏览器访问不到：看绑定地址、端口、防火墙和真实入口；Web Origin须匹配员工实际地址。
- 数据库密码错误：数据库首装之后，改 `.env` **不会改已有角色密码**；由DBA受控变更后再同步配置，不要删卷重建。

## 首装 SQL 权限失败的恢复（保留数据卷）

早期离线包在 `umask 077` 下将 `postgres-init.sql` 打成0600，PostgreSQL运行用户UID999不可读，首装日志出现 `10-adi.sql: Permission denied`。进程重启后数据目录已存在，首装脚本会被跳过；旧的Unix socket健康探针仍可能显示healthy，应用实际连接则因为adi_app尚未创建而返回28P01。

新打包脚本将不含秘密的SQL设为0644；导入脚本也在校验摘要后恢复该权限，覆盖接收机器解包时的限制性umask。`.env`仍保持0600。数据库健康检查同时要求最终TCP服务、可登录的adi_app和public.btree_gist，防止首装不完整被当作健康。

以下恢复**仅适用于已确认的全新首装失败**：adi_app不存在、btree_gist不存在，业务表为0。已有角色、业务表、旧迁移账本或恢复隔离时，由DBA按相应路径处理，不直接重放。不要删除任何数据卷。

在原部署目录，由获得本次数据库初始化授权的运维执行：

```sh
# 文件不含密码；密码仍由容器环境传给psql变量
chmod 0644 postgres-init.sql
# 只补齐失败的数据库首装，角色/授权/扩展在同一事务中完成
# -v ON_ERROR_STOP=1保证任一步失败即停止并回滚
docker-compose exec --user postgres postgres \
  psql -U adi_bootstrap -d adi -v ON_ERROR_STOP=1 --single-transaction \
  -f /docker-entrypoint-initdb.d/10-adi.sql
# 预期CREATE ROLE、GRANT、CREATE EXTENSION；不得有错误
# 重新运行本次业务迁移与配置管理员同步，成功退出码必须为0
docker-compose up --no-deps --force-recreate --exit-code-from initialize initialize
# 上一步失败时不继续
docker-compose up -d --wait --wait-timeout 180
```

数据库已有目录时，单纯chmod后重新up不会自动重放首装SQL；因此必须先确认条件，再显式执行以上首装事务。此操作不会改变现有数据库角色密码；已经存在的adi_app会令事务失败并回滚。最后检查四应用、健康端点、网页登录和业务链路，数据库进程健康不替代这些验收。

## Trae 插件使用公开 Web 地址

`adi-project-tracker` 的 Web Url 使用本部署的统一公开根入口，例如 `http://server.example.org:4181`。不要填写容器内 API 的4180端口：API没有主机端口映射，Web将 `/api/` 转发到API、`/hooks` 转发到collector。使用HTTPS入口时填实际公开域名。

在Trae**原生扩展设置**中填写 `adiProjectTracker.webUrl`，通过插件内部表单注册或登录本人平台账号。认证后自动获取共用 API 令牌与个人 Hook 材料，安装到当前用户标准 `.trae-cn`；必要的一次 Hooks 启用设置由用户确认。`adiProjectTracker.enabled` 控制本机两路采集，退出本机或最后窗口关闭会停止采集。本地 macOS/Windows 与 Remote SSH 路径按发行版本分别验收；本人历史分析遵守插件令牌的本人范围。真实设备验收与本机文件就绪分别记录。

新版不可直接对非空旧schema执行initialize；必须按[独立新数据集切换](#dataset-rebuild)保留源、备份和密钥/清理证明，验证独立目标后开放。

<a id="dataset-rebuild"></a>

## 独立新数据集切换

适用于旧协议试点或旧测试库重建统计基线，普通人员/期间清理仍使用清理 API。源库、历史迁移账本、备份、独立 cleanup journal 和原 32 字节凭据密钥全部保留；目标必须是与源 schema 名称不同的独立空 schema。不能先对旧源运行新版 migrate、db-init 或 initialize，也不能改历史 SQL/checksum 消除报错。

使用当前 API 发行物的 `apps/api/dist/dataset-rebuild-cli.js`，专用运维进程按 [配置模板](../product/dataset-rebuild.env.example) 注入 `ADI_REBUILD_*`。CLI 不读取根 `.env`；密码、连接串及令牌不放在命令参数或日志中。离线容器需要运维将同一私有配置和文件挂入专用 API 镜像进程，不能直接把以下宿主 Node 命令当作 Compose 命令。

1. **预览与冻结。** 仅配置源连接/schema，运行 `preview` 核对 dataset_id、基础/排除表计数与指纹，不修改源库。停止源 API、Collector、全部 Worker、initialize 和其他写入者，确认网络隔离；核验备份、独立 journal、删除检查点及密钥。目标也保持没有业务入口和后台写入者，审核变量不替代实际停写证据。
2. **准备空目标与清单。** 填写目标连接、不同 schema 及相同值的 `ADI_REBUILD_TARGET_CONFIRMED_SCHEMA`，设定经确认的北京时间基线日期。目标预装 `public.btree_gist` 和 `public.pg_trgm`；执行 `prepare-target` 正常迁移并关闭 collection，再用 `plan` 生成受保护清单。清单绑定源/目标身份、指纹、复制白名单及基线；将输出的 artifact 摘要填入 `ADI_REBUILD_ARTIFACT_DIGEST`。
3. **复制并保持关闭。** 审核停写、隔离、备份/journal和密钥；源/目标密钥文件必须是相同内容的 32 字节私有普通文件，无组/其他人权限。执行 `execute` 后运行 `status`。基础身份、账号/部门、白名单、供应商配置、有效凭据及来源元数据保留；项目身份哈希与序号屏障用于防重放。旧 Hook、用量、会话、项目观测、登录会话、任务及私有列表快照不复制，累计采纳重置。当前版本也保留插件发行包和渠道指针，交付物转移总量限制为 128 MiB。
4. **验证。** `verify` 核验源未变化、基础副本符合清单、使用数据为空、基线正确、目标保持关闭且无恢复隔离。将输出的 `validation_digest` 填入 `ADI_REBUILD_VALIDATION_DIGEST`。另验隔离新版 API/Worker/Collector、插件认证与来源证明、协议2 Hook、两来源清理和目标 Windows/macOS Trae；摘要只证明结构/复制检查。
5. **显式开放。** 基线日期已到且验证完成后，设置 `ADI_REBUILD_VALIDATION_COMPLETED=1` 再 `open`；CLI 重验清单和当前摘要，漂移、未来基线或恢复隔离均拒绝开放。然后才按部署流程启用新版服务、切换数据库地址/schema并接入流量。保留旧部署冻结，不将新旧 dataset 的 journal 或恢复材料混接。

以下命令按步骤分别执行，每步成功并完成对应审核后再进入下一步；`/protected/rebuild-plan.json` 为运维选择的私有文件示例：

```sh
node apps/api/dist/dataset-rebuild-cli.js preview
node apps/api/dist/dataset-rebuild-cli.js prepare-target
node apps/api/dist/dataset-rebuild-cli.js plan /protected/rebuild-plan.json
node apps/api/dist/dataset-rebuild-cli.js execute /protected/rebuild-plan.json
node apps/api/dist/dataset-rebuild-cli.js status
node apps/api/dist/dataset-rebuild-cli.js verify /protected/rebuild-plan.json
node apps/api/dist/dataset-rebuild-cli.js open /protected/rebuild-plan.json
```

失败保持目标入口隔离；相同完整清单可核对后重试，其他清单不能接管。连接/I/O失败或 COMMIT 回执丢失时，先用 `status` 核对 dataset_id、collection_enabled、manifest_digest 和 opened_at，不能推断已回滚。回退先停新目标服务，再恢复原旧部署及源库配置；保留材料。`external_isolation_verified:false` 始终表示还需运维证明；本文迁入既有操作约束，不表示本轮已执行真实数据切换。


## 6. 后续升级

每次先从新的干净提交构建四应用，再运行 `sh export-images.sh --local --tag 完整提交SHA --kind upgrade` 生成新包并传输。先在服务器另一目录校验并解包；不要直接覆盖旧 `.env`。

在旧部署目录停止应用并备份，PostgreSQL继续运行：

```sh
docker-compose stop web api collector worker
bash backup.sh
```

应生成 `backups/<UTC时间>/database.dump`、`private-volumes.tar`、`.env`、Compose和校验清单。备份以管理角色运行pg_dump，密码不在参数中；密钥与journal单独打包。确认备份目录非空、摘要正确，受保护复制到异机。备份完成不是恢复演练通过；脚本失败留下的目录不算完成备份。

将旧私有配置复制到新解包目录，核对新 `.env.example` 的新增字段，然后在新目录执行：

```sh
# 两个路径替换为实际绝对路径；不要复制新包里的空.env覆盖旧配置
cp /path/to/old-release/.env /path/to/new-release/.env
cd /path/to/new-release
chmod 600 .env
bash load-images.sh
docker-compose config --quiet
# 必须前台看到本次初始化成功，并以退出码0返回
docker-compose up --no-deps --force-recreate --exit-code-from initialize initialize
# 上一步失败时不要执行下行
docker-compose up -d --wait --wait-timeout 180
```

升级时保持原 `COMPOSE_PROJECT_NAME`，确保复用原来的数据卷。新包中prepare-storage逻辑相同时无需重复执行；如需修复权限，可先执行 `docker-compose up --no-deps --force-recreate --exit-code-from prepare-storage prepare-storage`。升级之后再次完成第5节业务验收。

SQL迁移仅向前，不能把加载旧包称为已经验证的回滚。需要恢复时，保留**最新**的独立cleanup journal，结合仓库 recovery-cli / recovery-access-cli 执行目标隔离、清理重放、身份审核和显式release；不要简单把旧数据库dump覆盖生产后开放入口。初始化不能绕过恢复隔离。本文不提供未经验证的自动恢复脚本。

## 升级时保留部署身份 <a id="rename-upgrade"></a>

升级前核对实际 Compose 项目名、数据库/密钥/journal 数据卷、端口和代理配置，并保留一致性备份。既有部署在新配置中明确填写原 `COMPOSE_PROJECT_NAME`，合并现场卷绑定；不要用新模板直接覆盖原配置，也不要运行 `down -v`。

核验包的摘要、架构、revision 与镜像内容 ID。停止应用后按部署说明升级并执行 initialize，等待服务就绪，再验证权限、客户端上报、派生和后台心跳。改项目名、迁移卷、数据库恢复是独立操作，不属于普通升级步骤。
