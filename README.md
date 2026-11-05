# DSH SuperAgent · Mashang Service

**Mashang 体系的本地 SuperAgent 运行与编排平台。**

## 仓库职责边界

本项目与现有 `mashang-service` 保持独立仓库、独立职责：

| 仓库 | 负责内容 |
| --- | --- |
| `dsh-superagent-mashang-service` | Agent 运行与编排：launchd 生命周期、DSH 集成、任务路由与执行协调、权限策略、菜单栏控制器及 Web 管理控制台。 |
| `mashang-service` | 汽车业务数据与分析：数据采集与更新、业务数据模型、指标口径、查询、分析及业务输出。 |

两者通过明确授权的任务、业务仓库工作副本或已有业务接口协作。
Agent 可以在 `mashang-service` 的任务工作副本中完成获授权的业务修改，
业务代码与结果应交付回该业务仓库，不复制进本编排仓库。
本仓库的名字表示服务于 Mashang 体系，不表示接管汽车业务实现；
不得将两个仓库合并，也不得在这里另建一套业务数据或分析逻辑。


This independently maintained repository is based on
[DeepSeek DSH SuperAgent](https://github.com/deepseek-ai/dsh-superagent-prototype).
It retains the original Git history and MIT license, including the DeepSeek
Harness Team copyright notice in [LICENSE](LICENSE). It is not an official
DeepSeek product. Local additions include launchd service management and the
native macOS menu-bar controller for the Mashang workflow.

Canonical repository: [zhangzihaoDT/dsh-superagent-mashang-service](https://github.com/zhangzihaoDT/dsh-superagent-mashang-service).
The previous [public Fork](https://github.com/zhangzihaoDT/dsh-superagent-prototype)
is retained as a migration backup.

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source
- [009 Local runtime setup](docs/009-local-runtime-setup.md)
- [010 macOS UI design](docs/010-macos-ui-design.md)
- [011 Workspace preparation](docs/011-workspace-prepare.md): clean worktrees, read-only business data, official query entries and timing
- [012 Prepare acceptance](docs/012-prepare-acceptance.md): the read-only Prepare acceptance record
- [013 Controlled production data jobs](docs/013-business-jobs.md): allowlist-authorized `data-refresh-daily` from Feishu or the Web session, with lock, timeout and verification

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)

## Local macOS runtime and menu-bar controller

This fork adds a user LaunchAgent (`local.dsh.superagent`) and a native AppKit
menu-bar controller. See [reproducible local setup](docs/009-local-runtime-setup.md)
for a fresh Mac, [deployment](docs/006-deployment.md) for operations and
[UI Design Spec](docs/010-macos-ui-design.md) for menu behavior.
Runtime state and credentials stay outside version control; regenerate the App
with `./scripts/build-macos-app`. Quitting the controller leaves launchd running.

For a new installation, clone the independent repository:

```sh
git clone https://github.com/zhangzihaoDT/dsh-superagent-mashang-service.git
cd dsh-superagent-mashang-service
```

Then follow the local macOS setup guide above. Existing installations should
keep their checkout directory unchanged: the LaunchAgent and controller embed
absolute paths. Changing Git remotes does not require restarting the service.
