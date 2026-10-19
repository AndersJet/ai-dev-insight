# 新版产品工作区；make dev 后台启动，make stop/kill 停止。
.DEFAULT_GOAL := help
ENV_FILE ?= .env
export ENV_FILE
PNPM ?= pnpm
COMPOSE ?= docker compose
IMAGE_PLATFORM ?= linux/amd64
IMAGE_PREFIX ?= local/ai-dev-insight
TEST_COMPOSE = $(COMPOSE) -p adi-test -f deploy/product/compose.test.yml
.PHONY: help install check build images lint typecheck test test-unit test-integration test-e2e \
        dev stop kill db-init \
        test-db-up test-db-down test-db-status clean clean-reports

help: ## 显示可用命令
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  make %-21s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## 按锁文件安装依赖
	$(PNPM) install --frozen-lockfile

check: ## Lint、类型、契约、构建和工程单测（不含数据库/E2E）
	$(PNPM) check

build: ## 构建全部工作区和 Hook 客户端包
	$(PNPM) build

images: ## 从干净提交构建四个本地镜像，不登录或上传仓库
	sh deploy/product/build-local.sh --platform "$(IMAGE_PLATFORM)" --image-prefix "$(IMAGE_PREFIX)"

lint: ## 检查代码规范和模块导入边界
	$(PNPM) lint

typecheck: ## 检查应用及测试类型
	$(PNPM) typecheck

test: ## 手动运行 CI 工程检查：Lint、构建、类型、契约和单测（不含数据库/E2E）
	$(PNPM) ci:check

test-unit: ## 仅运行工程单测
	$(PNPM) test

test-integration: ## 真实 PostgreSQL 集成测试；先启动独立测试库
	$(PNPM) test:integration

test-e2e: ## 真实浏览器业务测试；先启动独立测试库
	$(PNPM) test:e2e

dev: ## 先停止并确认后台进程退出，再初始化和启动；日志 .run/dev.log
	node scripts/dev-control.mjs restart

stop: ## 优雅停止本目录后台应用，超时后清理进程组；保留数据库
	node scripts/dev-control.mjs stop

kill: ## 强制终止本目录后台应用进程组；保留数据库
	node scripts/dev-control.mjs kill

db-init: ## 加载环境并初始化/升级目标 schema 与固定管理员，不创建数据库实例
	$(PNPM) db:init

test-db-up: ## 启动本机合成测试库 :55438（tmpfs，不作持久开发库）
	$(TEST_COMPOSE) up -d --wait

test-db-down: ## 停止本项目合成测试库；其临时数据会丢失
	$(TEST_COMPOSE) down

test-db-status: ## 查看本项目测试库状态
	$(TEST_COMPOSE) ps

clean: ## 清理构建产物和工具缓存；保留数据库、配置及运行证据
	@for pkg in apps/* packages/* trae-plugin; do \
		[ -d "$$pkg" ] && [ ! -L "$$pkg" ] || continue; \
		rm -rf "$$pkg/dist" "$$pkg/node_modules/.cache"; \
		for cache in "$$pkg"/node_modules/.vite*; do \
			[ -d "$$cache" ] && [ ! -L "$$cache" ] && rm -rf "$$cache"; \
		done; \
		rm -f "$$pkg"/*.tsbuildinfo; \
	done
	@rm -rf node_modules/.cache
	@rm -f ./*.tsbuildinfo

clean-reports: ## 清理可重建的本地 E2E 报告（不会清空整个 .run）
	@rm -rf .run/e2e-results .run/e2e-report
