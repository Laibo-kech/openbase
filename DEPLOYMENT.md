# 部署与回滚

## 首次部署

```bash
cp .env.example .env
# 编辑 .env，设置随机数据库密码和管理后台密码哈希
chmod 600 .env
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:13280/api/health
curl -fsS http://127.0.0.1:13281/api/health
```

不要把 `.env`、数据库备份或用户上传文件提交到 GitHub。

## 大改前备份

```bash
git status --short
git add -A
git commit -m "backup: before major change"
git push

docker compose exec -T db pg_dump -U multibase -d multibase -Fc > multibase-before-upgrade.dump
```

数据库备份应保存到受保护的服务器备份目录或对象存储，不要放进公开仓库。

## 候选版本

大型升级应先使用新镜像和独立候选端口验证，不直接覆盖当前入口。至少检查：

- 自动化测试和前端构建
- 应用与管理后台健康接口
- 登录、权限隔离和核心数据操作
- 数据库数量和样例记录回读
- 服务端日志无重复错误
- 原入口仍可访问

查找引用候选版本还应执行：

```bash
LOOKUP_ACCEPTANCE_BASE_URL=http://127.0.0.1:14280 npm run acceptance:lookup
```

验收覆盖稳定关联 ID、三步配置、单条和多条关联、8 种汇总、4 种返回类型、空值策略、自动重算、删除标记、影响警告、依赖查看、循环引用拦截、只读保护、任务状态和重试。

## 回滚

候选版本未通过验收时，继续使用旧容器和旧入口。正式切换后出现问题时，恢复升级前代码提交和 PostgreSQL 备份，再重新启动旧镜像。
