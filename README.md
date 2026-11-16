# takeit

把一个浏览器标签页交给 agent。

装扩展。点接管。复制 prompt。

```sh
npx -y @liyang8246/takeit <token> help
```

单 tab。单次进程。无常驻桥。

## 开发

```sh
pnpm install
pnpm build
pnpm run ci
```

在 Chrome 加载 [extension](<extension/>)。开发使用 Node.js 24.15+；CLI 仍支持 22.18+。

Token 即授权。切换即撤权。超时不回滚。
