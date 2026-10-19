#!/usr/bin/env bash
# One entry point; configuration is data, never sourced as shell code.
set +x
set -euo pipefail
umask 077
payload=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$payload/lib.sh"
action=${1:-}; [[ $# == 0 ]] || shift
environment=''; target=''; config=''; compose_bin=''; web_compat=''; cleanup_mode=preview
while (( $# )); do
  case "$1" in
    --web-el7-compat) web_compat=web-el7-compat; shift ;;
    --apply|--purge)
      [[ "$cleanup_mode" == preview ]] || manual_die '--apply 和 --purge 不能同时使用。'
      [[ "$1" == --apply ]] && cleanup_mode=archive || cleanup_mode=purge
      shift ;;
    --env|--root|--config|--compose-bin)
      (( $# >= 2 )) || manual_die "缺少参数：$1"
      case "$1" in --env) environment=$2 ;; --root) target=$2 ;; --config) config=$2 ;; --compose-bin) compose_bin=$2 ;; esac
      shift 2 ;;
    *) manual_die "未知参数：$1" ;;
  esac
done
case "$action" in install|upgrade|recover|status|cleanup) ;; *) manual_die '操作必须为 install、upgrade、recover、status 或 cleanup。' ;; esac
[[ "$action" == cleanup || "$cleanup_mode" == preview ]] || manual_die '--apply 和 --purge 只用于 cleanup。'
case "$environment" in prod) default_root=/opt/oss-llm/ai-dev-insight ;; test) default_root=/opt/oss-llm/ai-dev-insight-test ;; *) manual_die '必须用 --env test 或 --env prod 明确选择环境。' ;; esac
target=${target:-$default_root}
[[ "$target" =~ ^/[a-zA-Z0-9_./-]+$ && "$target" != *'/../'* && "$target" != */.. && "$target" != / && "$target" != /opt && "$target" != /opt/oss-llm ]] || manual_die '部署目录必须是独立的绝对路径，不能含空格或上级目录。'
[[ ! -L "$target" ]] || manual_die '不自动接管符号链接目录。'
if [[ "$action" != install ]]; then
  [[ -d "$target" && -f "$target/.env" ]] || manual_die '未找到已部署环境，请核对 --env 和 --root。'
  [[ -f "$target/docker-compose.yml" || ( "$action" == recover && -f "$target/.deployment-pending" ) ]] || manual_die '部署配置缺失，请核对目录和未完成操作。'
fi
mkdir -p -- "$target"
target=$(cd -- "$target" && pwd -P)
case "$target" in /opt/oss-llm/ai-dev-insight) [[ "$environment" == prod ]] || manual_die '正式目录不能作为测试环境操作。' ;; /opt/oss-llm/ai-dev-insight-test) [[ "$environment" == test ]] || manual_die '测试目录不能作为正式环境操作。' ;; esac
state_value() { [[ ! -f "$1" ]] || awk -F= -v key="$2" '$1 == key {print substr($0, length(key)+2)}' "$1"; }
for record in .deployment-success .deployment-pending; do
  bound=$(state_value "$target/$record" environment)
  [[ -z "$bound" || "$bound" == "$environment" ]] || manual_die '本目录已绑定其他环境，拒绝继续。'
done
lock="$target/.deploy-lock"
if [[ -d "$lock" && -f "$lock/pid" ]]; then
  owner=$(cat "$lock/pid")
  if [[ "$owner" =~ ^[0-9]+$ ]] && ! kill -0 "$owner" 2>/dev/null; then rm -f -- "$lock/pid"; rmdir "$lock" 2>/dev/null || true; fi
fi
mkdir "$lock" 2>/dev/null || manual_die '另一次操作正在执行；不要同时升级、恢复或手动操作 Compose。'
printf '%s\n' "$$" > "$lock/pid"
work=''; log=''; changed=false; backup=''; phase=检查
cleanup() {
  code=$?
  trap - EXIT INT TERM
  if (( code != 0 )); then
    if [[ "$changed" == true ]]; then
      compose -f "$target/docker-compose.yml" stop web api collector worker >> "$log" 2>&1 || true
      printf '\n操作未完成，失败阶段：%s。应用保持停止，数据库和数据保留。\n' "$phase" >&2
      printf '修正原因后，用同一个包继续：bash %q recover --env %q --root %q\n' "${ADI_RUN_FILE:-$payload/deploy.sh}" "$environment" "$target" >&2
    else printf '\n操作未完成，本次尚未执行停服步骤；已有未完成状态请查看 status。\n' >&2; fi
    [[ -z "$backup" ]] || printf '升级前备份：%s（仅 .complete 存在时表示完整）\n' "$backup" >&2
    [[ -z "$log" ]] || printf '私有日志：%s\n' "$log" >&2
  fi
  [[ -z "$work" ]] || rm -rf -- "$work"
  rm -f -- "$lock/pid"; rmdir "$lock" 2>/dev/null || true
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$target/logs"
log=$(mktemp "$target/logs/deploy-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
work=$(mktemp -d "$target/.deploy-work.XXXXXXXX")
step() {
  phase=$1; shift
  printf '→ %s\n' "$phase"
  "$@" >> "$log" 2>&1 || manual_die "$phase 失败，详情已写入私有日志。"
}
command -v docker >/dev/null || manual_die '需要先安装并启动 Docker。'
step '检查 Docker' docker info --format '{{.ServerVersion}} {{.OSType}}/{{.Architecture}}'
if [[ -n "$compose_bin" ]]; then
  [[ "$compose_bin" == /* && -x "$compose_bin" ]] || manual_die '--compose-bin 必须指向已有 Compose V2 的绝对路径。'
  compose_cmd=("$compose_bin")
elif [[ -x "$target/docker-compose" ]]; then compose_cmd=("$target/docker-compose")
elif docker compose version >/dev/null 2>&1; then compose_cmd=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then compose_cmd=(docker-compose)
else manual_die '需要 Docker Compose V2（2.20 或以上）；现场独立程序可保留在部署目录。'; fi
version=$("${compose_cmd[@]}" version --short 2>> "$log")
[[ "$version" =~ ^v?2\.([0-9]+)\. && "${BASH_REMATCH[1]}" -ge 20 ]] || manual_die '需要 Docker Compose V2 2.20 或以上。'
compose() (
  # Ambient application/Compose variables must not redirect this operation.
  while IFS='=' read -r key _; do [[ "$key" =~ ^(ADI_[A-Z0-9_]+|TRAE_OPENAPI_[A-Z0-9_]+|COMPOSE_PROJECT_NAME)$ ]] && unset "$key"; done < "$target/.env"
  unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES
  cd "$target"
  "${compose_cmd[@]}" --project-directory "$target" --env-file "$target/.env" "$@"
)
release=$(awk '$1 == "#" && $2 == "release" {print $3}' "$payload/images.manifest")
kind=$(awk '$1 == "#" && $2 == "kind" {print $3}' "$payload/images.manifest")
[[ "$release" =~ ^[a-f0-9]{40}$ && ( "$kind" == install || "$kind" == upgrade ) ]] || manual_die '安装包版本信息不合法。'
fingerprint=$(sha256_file "$payload/SHA256SUMS")
pending="$target/.deployment-pending"
operation=$action
if [[ -f "$pending" ]]; then
  [[ "$action" != cleanup ]] || manual_die '上次安装或升级未完成，先 recover，再整理目录。'
  [[ "$action" == status || "$(state_value "$pending" manifest)" == "$fingerprint" ]] || manual_die '上次操作未完成，请先使用上次的同一个包 recover，不切换其他版本。'
  operation=$(state_value "$pending" operation)
  [[ "$operation" == install || "$operation" == upgrade ]] || manual_die '操作记录不完整，请检查私有日志。'
  backup=$(state_value "$pending" backup)
  if [[ -z "$web_compat" ]]; then web_compat=$(state_value "$pending" web_compat); fi
  [[ -z "$web_compat" || "$web_compat" == web-el7-compat ]] || manual_die '兼容设置记录不合法。'
elif [[ "$action" == recover ]]; then manual_die '没有未完成的操作，不需要恢复。'; fi
if [[ "$action" == status ]]; then
  printf '环境：%s\n目录：%s\n成功版本：%s\n未完成阶段：%s\n' "$environment" "$target" "$(state_value "$target/.deployment-success" version)" "$(state_value "$pending" phase)"
  compose -f "$target/docker-compose.yml" ps
  exit 0
fi
if [[ "$operation" == install && ! -f "$pending" ]]; then
  [[ "$kind" == install ]] || manual_die '首次安装需要 install 包，upgrade 包不包含数据库镜像。'
  [[ ! -e "$target/.env" && ! -e "$target/docker-compose.yml" && ! -e "$target/data" ]] || manual_die '目录已有配置或数据，不能当作首次安装；已有服务请用 upgrade。'
  if [[ -n "$config" ]]; then
    [[ "$config" == /* && -f "$config" ]] || manual_die '--config 需要私有配置文件的绝对路径。'
    cp "$config" "$target/.env"
  else
    command -v openssl >/dev/null || manual_die '首次安装需要 openssl 生成随机密码。'
    [[ -t 0 ]] || manual_die '首次安装需要在终端回答配置问题，或通过 --config 提供私有配置。'
    read -r -p '员工访问地址，例如 http://server.example.org:4181：' origin
    [[ "$origin" =~ ^https?://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || manual_die '访问地址格式不正确；不带路径或末尾斜线。'
    read -r -p '配置管理员邮箱：' email
    [[ "$email" =~ ^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9.-]+$ ]] || manual_die '邮箱格式不正确。'
    read -r -p '允许注册的邮箱域，多个用英文逗号分隔，留空不限制：' domains
    [[ -z "$domains" || "$domains" =~ ^[a-zA-Z0-9.,-]+$ ]] || manual_die '邮箱域格式不正确。'
    web_port=4181; collector_port=4186
    [[ "$environment" != test ]] || { web_port=4182; collector_port=4187; }
    [[ ! "$origin" =~ :([0-9]+)$ ]] || web_port=${BASH_REMATCH[1]}
    awk -F= '$1 !~ /^(COMPOSE_PROJECT_NAME|ADI_PG_ADMIN_PASSWORD|ADI_APP_DB_PASSWORD|ADI_ADMIN_PASSWORD|ADI_ADMIN_EMAIL|ADI_EMAIL_DOMAINS|ADI_WEB_ORIGIN|ADI_PUBLIC_COLLECTOR_URL|ADI_WEB_HOST_PORT|ADI_COLLECTOR_HOST_PORT)$/' "$payload/.env.example" > "$target/.env"
    # All values below are generated or strictly validated, never shell code.
    {
      printf 'COMPOSE_PROJECT_NAME=ai-dev-insight-%s\n' "$environment"
      printf 'ADI_PG_ADMIN_PASSWORD=%s\nADI_APP_DB_PASSWORD=%s\nADI_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" "$(openssl rand -hex 24)"
      printf 'ADI_ADMIN_EMAIL=%s\nADI_EMAIL_DOMAINS=%s\nADI_WEB_ORIGIN=%s\nADI_PUBLIC_COLLECTOR_URL=%s/hooks\n' "$email" "$domains" "$origin" "$origin"
      printf 'ADI_WEB_HOST_PORT=%s\nADI_COLLECTOR_HOST_PORT=%s\n' "$web_port" "$collector_port"
    } >> "$target/.env"
    printf '随机管理员密码已保存到 %s/.env 的 ADI_ADMIN_PASSWORD，请私下保管。\n' "$target"
  fi
fi
[[ -f "$target/.env" ]] || manual_die '环境配置缺失。'
chmod 0600 "$target/.env"
write_pending() {
  printf 'environment=%s\nversion=%s\nmanifest=%s\noperation=%s\nphase=%s\nbackup=%s\nweb_compat=%s\n' "$environment" "$release" "$fingerprint" "$operation" "$1" "$backup" "$web_compat" > "$pending.tmp"
  mv "$pending.tmp" "$pending"
}
if [[ "$operation" == install && ! -f "$pending" ]]; then write_pending prepared; fi
printf '环境：%s\n目录：%s\n目标版本：%s\n' "$environment" "$target" "$release"
if [[ "$action" == cleanup ]]; then
  api_id=$(compose -f "$target/docker-compose.yml" ps -aq api)
  [[ -n "$api_id" && "$api_id" != *$'\n'* ]] || manual_die '无法确定本环境的 API 容器。'
  api_image=$(docker inspect "$api_id" --format '{{.Image}}')
  [[ "$api_image" =~ ^sha256:[a-f0-9]{64}$ ]] || manual_die '无法确定辅助工具的镜像身份。'
else
  step '校验并导入缺少的镜像' bash "$payload/load-images.sh"
  api_image="ai-dev-insight-offline-api:$release"
fi
tool() {
  docker run --rm -i --network "${tool_network:-none}" --read-only --cap-drop ALL --security-opt no-new-privileges:true --user "$(id -u):$(id -g)" \
    --mount "type=bind,src=$payload,dst=/adi-tools,readonly" --mount "type=bind,src=$work,dst=/adi-work,readonly" --mount "type=bind,src=$target,dst=/adi-site,readonly" \
    --entrypoint node "$api_image" /adi-tools/site-config.mjs "$@"
}
if [[ -f "$target/docker-compose.yml" ]]; then
  compose -f "$target/docker-compose.yml" config --format json > "$work/current.json" 2>> "$log" || manual_die '现有配置不合法；尚未停服。'
  project=$(tool project 2>> "$log") || manual_die '无法确定现有项目名。'
else
  compose -f "$payload/docker-compose.yml" config --format json > "$work/template.json" 2>> "$log" || manual_die '本版本配置不完整；检查新增必填配置，尚未停服。'
  project=$(tool project template.json 2>> "$log") || manual_die '无法确定项目名。'
fi
ids=$(docker ps -aq --filter "label=com.docker.compose.project=$project")
if [[ -n "$ids" ]]; then
  # Docker IDs contain only hex digits; deliberate word splitting of the list.
  docker inspect $ids > "$work/containers.json" 2>> "$log"
else printf '[]\n' > "$work/containers.json"; fi
if [[ -f "$work/current.json" ]]; then
  partial=''; [[ ! -f "$pending" ]] || partial=partial
  step '核对原容器和数据卷归属' tool verify "$target" "$partial"
  current_version=$(tool current-version 2>> "$log") || manual_die '无法读取当前版本；尚未停服。'
  printf '当前版本：%s\n' "$current_version"
elif [[ -n "$ids" ]]; then manual_die '项目名已被其他目录的容器使用，拒绝首次安装。'
elif [[ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]]; then manual_die '项目名已有持久卷，不作为全新环境初始化。'; fi
if [[ "$action" == cleanup ]]; then
  all_ids=$(docker ps -aq)
  : > "$work/protected-paths"
  if [[ -n "$all_ids" ]]; then docker inspect $all_ids --format '{{range .Mounts}}{{println .Source}}{{end}}' >> "$work/protected-paths" 2>> "$log"; fi
  volumes=$(docker volume ls -q)
  if [[ -n "$volumes" ]]; then docker volume inspect $volumes --format '{{if .Options}}{{index .Options "device"}}{{end}}' >> "$work/protected-paths" 2>> "$log"; fi
  printf '%s\n' "${ADI_RUN_FILE:-}" >> "$work/protected-paths"
  tool cleanup "$target" > "$work/cleanup-plan" 2>> "$log" || manual_die '无法核对整理清单，未移动或删除文件。'
  phase=目录整理
  bash "$payload/archive.sh" "$target" "$work/cleanup-plan" "$cleanup_mode"
  exit 0
fi
if [[ ! -f "$pending" && "$(state_value "$target/.deployment-success" manifest)" == "$fingerprint" ]]; then
  step '核对当前版本健康状态' tool health
  printf '本环境已成功运行本版本，无需升级。\n'; exit 0
fi
available=$(df -Pk "$target" | awk 'END {print $4}')
required=1048576
if [[ "$operation" == upgrade ]]; then
  database_bytes=$(compose -f "$target/docker-compose.yml" exec -T postgres psql -U adi_bootstrap -d adi -Atc 'SELECT pg_database_size(current_database())' 2>> "$log") || manual_die '无法预估数据库备份空间，尚未停服。'
  [[ "$database_bytes" =~ ^[0-9]+$ ]] || manual_die '无法预估数据库备份空间，尚未停服。'
  required=$((required + database_bytes / 1024 * 2))
fi
(( available >= required )) || manual_die '部署目录可用空间不足以保存升级前备份，请先核对磁盘。'
compose -p "$project" -f "$payload/docker-compose.yml" config --format json > "$work/template.json" 2>> "$log" || manual_die '本版本配置不完整；检查新增必填配置，尚未停服。'
tool merge "$release" "$web_compat" > "$work/candidate.yml" 2>> "$log" || manual_die '无法安全合并现场配置，尚未停服。'
step '检查新配置' compose -p "$project" -f "$work/candidate.yml" config --quiet
if [[ "$operation" == install && ! -f "$target/docker-compose.yml" ]]; then tool_network=host; step '检查首次安装端口' tool ports; unset tool_network; fi
if [[ "$operation" == upgrade && ! -f "$backup/.complete" ]]; then
  backup="$target/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  tool snapshot > "$work/snapshot.yml" 2>> "$log" || manual_die '无法固定原版本镜像，尚未停服。'
fi
write_pending stopping
changed=true
if [[ -f "$target/docker-compose.yml" ]]; then step '停止应用写入（数据库继续运行）' compose -f "$target/docker-compose.yml" stop web api collector worker initialize prepare-storage; fi
if [[ "$operation" == upgrade ]]; then
  if [[ -f "$backup/.complete" ]]; then
    step '核验已有升级前备份' bash -c 'cd "$1"; sha256sum -c SHA256SUMS' -- "$backup"
  else
    [[ -f "$work/snapshot.yml" ]] || manual_die '上次备份未完成，请核对日志；不覆盖不完整备份。'
    write_pending backup
    step '备份数据库、密钥、状态及原配置' bash "$payload/backup.sh" --root "$target" --destination "$backup" --snapshot "$work/snapshot.yml" --compose-bin "${compose_cmd[0]}"
  fi
fi
for file in lib.sh backup.sh README.md REFERENCE.md; do cp "$payload/$file" "$target/$file.new"; mv "$target/$file.new" "$target/$file"; done
if [[ ! -e "$target/postgres-init.sql" ]]; then cp "$payload/postgres-init.sql" "$target/postgres-init.sql"; fi
chmod 0644 "$target/postgres-init.sql"
cp "$work/candidate.yml" "$target/docker-compose.yml.new"
mv "$target/docker-compose.yml.new" "$target/docker-compose.yml"
cp "$payload/images.manifest" "$target/images.manifest"
write_pending migrating
step '等待数据库就绪' compose -f "$target/docker-compose.yml" up -d --no-deps --no-recreate --wait --wait-timeout 120 postgres
step '准备持久目录权限' compose -f "$target/docker-compose.yml" run --rm --no-deps -T prepare-storage
step '执行数据库迁移和初始化' compose -f "$target/docker-compose.yml" run --rm --no-deps -T initialize
write_pending starting
step '启动应用并等待健康检查' compose -f "$target/docker-compose.yml" up -d --no-deps --wait --wait-timeout 300 worker collector api web
compose -f "$target/docker-compose.yml" config --format json > "$work/current.json" 2>> "$log"
ids=$(compose -f "$target/docker-compose.yml" ps -q postgres api collector worker web)
[[ -n "$ids" ]] || manual_die '未找到常驻容器。'
docker inspect $ids > "$work/containers.json" 2>> "$log"
step '核对服务状态和版本' tool health
printf 'environment=%s\nversion=%s\nmanifest=%s\nproject=%s\nbackup=%s\n' "$environment" "$release" "$fingerprint" "$project" "$backup" > "$target/.deployment-success.tmp"
mv "$target/.deployment-success.tmp" "$target/.deployment-success"
rm -f -- "$pending"
changed=false
printf '\n自动检查通过，待业务验收：\n1. 用管理员登录页面。\n2. 完成一次客户端上报，并在页面确认结果。\n'
printf '日志：%s\n' "$log"
[[ -z "$backup" ]] || printf '升级前备份：%s\n' "$backup"
printf '测试验收通过后，使用同一个包执行 upgrade --env prod；本机已有镜像不会重复导入。\n'
