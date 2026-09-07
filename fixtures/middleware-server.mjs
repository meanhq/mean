import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
export async function startFixture(root, host, mean) {
  const require = createRequire(join(root, 'package.json'));
  const port = Number(process.env.PORT || 8100);
  const building = process.argv.includes('--build');
  const bundled = host === 'webpack' || host === 'rspack';
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const compiler = bundled
    ? (host === 'webpack' ? require('webpack') : require('@rspack/core').rspack)({
        mode: building ? 'production' : 'development',
        context: root,
        entry: './client.js',
        output: { path: join(root, 'dist'), filename: 'client.js', publicPath: '/' },
        devtool: false,
      })
    : undefined;

  if (building) {
    await mkdir(join(root, 'dist'), { recursive: true });
    if (compiler) {
      await new Promise((resolve, reject) =>
        compiler.run((error, stats) => {
          compiler.close((closeError) => {
            if (error || closeError || stats?.hasErrors())
              reject(error || closeError || new Error(stats.toString()));
            else resolve();
          });
        }),
      );
    } else {
      await writeFile(join(root, 'dist/client.js'), await readFile(join(root, 'client.js')));
    }
    await writeFile(join(root, 'dist/index.html'), html);
    const serve = `import { createServer } from 'node:http';\nimport { readFile } from 'node:fs/promises';\nconst respond = async (req, res) => {\n const file = req.url === '/' ? 'index.html' : req.url === '/client.js' ? 'client.js' : undefined;\n if (!file) { res.statusCode = 404; res.end(); return; }\n try { res.statusCode = 200; res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(await readFile(new URL(file, import.meta.url))); } catch { res.statusCode = 500; res.end(); }\n};\n`;
    const mount =
      host === 'express'
        ? `import express from 'express';\nconst app = express(); app.use(respond); const server = createServer(app);\n`
        : host === 'koa'
          ? `import Koa from 'koa';\nconst app = new Koa(); app.use(async ctx => { ctx.respond = false; await respond(ctx.req, ctx.res); }); const server = createServer(app.callback());\n`
          : `const server = createServer(respond);\n`;
    await writeFile(
      join(root, 'dist/server.mjs'),
      `${serve}${mount}server.listen(Number(process.env.PORT || 8100), '127.0.0.1');\n`,
    );
    return;
  }

  let middleware;
  const options = { dev: true, origin: `http://127.0.0.1:${port}`, root };
  const respond = async (req, res) => {
    if (req.url === '/') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html');
      res.end(html.replace('</head>', `${middleware.scriptTag}</head>`));
    } else if (!bundled && req.url === '/client.js') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await readFile(join(root, 'client.js')));
    } else {
      res.statusCode = 404;
      res.end();
    }
  };

  if (compiler) {
    const DevServer =
      host === 'webpack'
        ? require('webpack-dev-server')
        : require('@rspack/dev-server').RspackDevServer;
    const devServer = new DevServer(
      {
        host: '127.0.0.1',
        port,
        hot: true,
        liveReload: false,
        static: false,
        historyApiFallback: false,
        client: { overlay: false, logging: 'none' },
        webSocketServer: { type: 'ws', options: { path: '/ws' } },
        setupMiddlewares(stack, server) {
          middleware = mean(server.server, options);
          stack.unshift({ name: 'mean', middleware });
          stack.push({ name: 'fixture-html', middleware: respond });
          return stack;
        },
      },
      compiler,
    );
    await devServer.start();
  } else if (host === 'express') {
    const app = require('express')();
    const server = createServer(app);
    middleware = mean(server, options);
    app.use(middleware);
    app.use(respond);
    server.listen(port, '127.0.0.1');
  } else {
    const Koa = require('koa');
    const app = new Koa();
    const server = createServer(app.callback());
    middleware = mean(server, options);
    app.use(async (ctx) => {
      ctx.respond = false;
      ctx.res.statusCode = 200;
      await new Promise((resolve, reject) => {
        const finish = () => {
          ctx.res.off('close', finish);
          resolve();
        };
        ctx.res.once('close', finish);
        middleware(ctx.req, ctx.res, () => {
          ctx.res.off('close', finish);
          respond(ctx.req, ctx.res).then(resolve, reject);
        });
      });
    });
    server.listen(port, '127.0.0.1');
  }
}
