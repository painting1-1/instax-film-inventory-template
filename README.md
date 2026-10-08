# 片刻库存 · 拍立得相纸库存模板

给拍立得爱好者的个人库存管理工具。部署到自己的 Cloudflare Pages 和 D1，电脑与手机用同一个解锁口令访问、同步自己的库存。

**这是独立部署的开源模板，不是公共账号服务。** 源码里只有预设商品库，初始库存和流水为空；每位使用者建立自己的数据库、设置自己的口令。

## 功能

- 商品库：51 项相机及相纸预设；相纸分 Mini / SQ / Wide，可添加、编辑、上传商品图、删除未使用商品，并检查重复商品。
- 库存：同型号合并数量、平均购入价、当前库存成本、官方价总额；相纸盒数 / 张数切换及即将过期提醒。
- 流水：购入、售出、使用，按批次扣减库存；平台、店铺 / 交易对象、有效期、单价及利润统计。
- 分享：生成剩余相纸库存长图，手机可调用系统分享；JSON 备份 / 恢复和 CSV 导出。
- 手机：底部导航、折叠筛选、紧凑流水显示。
- 同步：服务端解锁、跨设备刷新、离线编辑保留、版本冲突保护。

没有流水清单、勾选汇总、一次性胶片相机、相册或邮箱注册。内部流水标识用于批次关联和利润计算，仍保存在数据中。

## 部署到 Cloudflare Pages

需要 GitHub、Cloudflare 账户。每个人使用自己的 D1 数据库。以下方式通过 GitHub 自动部署。

### 1. 复制仓库

点击本仓库右上角 **Use this template → Create a new repository**，生成自己的仓库；也可以 Fork。

### 2. 创建并初始化数据库

在 Cloudflare 的 D1 页面新建数据库（例如 `instax-film-inventory`），复制它的 Database ID。

打开数据库的 Console，把本仓库 `migrations/0001_personal.sql` 的完整内容粘贴进去运行。它只创建数据表，不包含库存或流水。

### 3. 修改配置

在自己的 GitHub 仓库编辑 `wrangler.jsonc`：

- `name`：改成准备使用的 Pages 项目名。
- `database_name`：改成刚创建的数据库名。
- `database_id`：将 `00000000-0000-0000-0000-000000000000` 替换成自己的 D1 Database ID。
- `binding` 保持为 `DB`，`pages_build_output_dir` 保持为 `./dist/client`。

配置文件是数据库绑定的来源，请在这里修改。**不要把解锁口令写进源码。**

### 4. 创建 Pages 项目

在 Cloudflare 的 Workers & Pages 中选择创建 **Pages**，连接自己的 GitHub 仓库。

| 配置 | 填写 |
| --- | --- |
| Production branch | `main` |
| Framework preset | None |
| Build command | `npm run build` |
| Build output directory | `dist/client` |
| Root directory | 留空 |

Pages 会同时部署仓库根目录 `functions/` 中的接口。不要只上传 `public/` 静态文件，否则没有云端同步。

### 5. 设置解锁口令

在该 Pages 项目的 Settings → Variables and Secrets 中，为 **Production** 添加：

- 名称：`OWNER_PASSPHRASE`
- 类型：Secret
- 值：自己的至少 12 位口令

设置后重新部署。访问该项目的 `pages.dev` 地址，输入口令解锁。

建议关闭自动 Preview branch 部署。若需要开发预览，请在 `env.preview` 中配置另一套 D1 绑定，并使用独立的预览口令，避免测试数据写入正式库存。

## 第一次验收

1. 解锁后应显示预设商品，但没有库存和流水；左下角显示“云端已同步”。
2. 录入测试购入，例如 2 盒 Mini 相纸，单价 50 元。等待同步完成。
3. 用另一台设备打开**同一个站点地址**并解锁，检查数量、金额与流水。
4. 录入半盒使用或一盒售出，确认另一台设备刷新后同步、利润计算正确。
5. 导出 JSON 备份；验收后删除测试流水。

未配置数据库或口令时，页面可能可以打开，但云端接口会报告配置未完成。只有明确显示“云端已同步”才表示保存成功。

## 本地开发 / 命令行部署

推荐 Node.js 22 或更新版本。

```bash
npm ci
npx wrangler d1 migrations apply DB --local
```

在仓库根目录创建仅保存在本机的 `.dev.vars`，内容为 `OWNER_PASSPHRASE="自己的至少12位测试口令"`，然后：

```bash
npm run dev
npm test
```

本地 D1 与云端数据库相互独立。本地测试数据不会自动上传。

如通过命令行部署：先修改配置中的数据库 ID 和项目名，再执行：

```bash
npx wrangler login
npx wrangler d1 migrations apply DB --remote
npx wrangler pages project create 你的项目名 --production-branch main
npx wrangler pages secret put OWNER_PASSPHRASE --project-name 你的项目名
npm run build
npx wrangler pages deploy dist/client --project-name 你的项目名
```

## 数据与维护

数据库存储商品、流水和设置。口令在服务端校验，访问库存 API 需要会话；这是单人库存工具，知道口令的人可以操作同一份库存。离线修改和版本冲突会保留本机数据，冲突时先导出备份再核对。

请定期导出 JSON。修改源码 / 更新模板时，不要导入别人的库存备份，也不要复用别人的数据库。代码公开不会公开已部署站点的 D1 内容；不要把 `.dev.vars`、API Token 或库存备份提交到 GitHub。

## 授权与素材

原创代码使用 MIT 许可证，详见 [LICENSE](LICENSE)。商品包装图片、品牌名称及品牌相关标识属于其权利人，**不在 MIT 授权范围内**，详见 [素材说明](THIRD_PARTY_NOTICES.md)。商品图不是统一由本项目原创，正式再分发或商用前请自行核实素材授权，也可以替换为自己拍摄的图片。

## 官方参考

- [Pages Git 集成](https://developers.cloudflare.com/pages/get-started/git-integration/)
- [Pages Wrangler 配置](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)
- [Pages 数据库绑定与 Secrets](https://developers.cloudflare.com/pages/functions/bindings/)
- [D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)
