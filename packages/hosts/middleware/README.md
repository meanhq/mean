# Middleware

`@meanhq/mean/middleware` mounts Mean on an existing loopback HTTP server. It does not stamp source or add framework support, so elements carry a tag, classes and path but no component or file.

```js
import { createServer } from 'node:http';
import express from 'express';
import { mean } from '@meanhq/mean/middleware';

const app = express();
const server = createServer(app);
const middleware = mean(server, {
  dev: process.env.NODE_ENV === 'development',
  origin: 'http://127.0.0.1:3000',
  root: process.cwd(),
});
app.use(middleware); // Mount before application routes.
app.get('/', (_request, response) => {
  response.type('html').send(`<html><head>${middleware.scriptTag}</head><body>Hello</body></html>`);
});
server.listen(3000, '127.0.0.1');
```

Read `middleware.scriptTag` when serving HTML, after the server starts listening. It is empty before listening, after disposal and when development is disabled. The configured origin must match the browser URL and actual port; `localhost` and `127.0.0.1` are different origins. A wildcard listener disables the relay. `dispose()` removes Mean's listeners and closes its sockets; server close also disposes it.

The middleware is callable. Koa needs an adapter that waits for the response or calls the next middleware; see `fixtures/middleware-server.mjs`. Webpack and Rspack mount through `setupMiddlewares`. Give the host's HMR socket its own path, such as `/ws`, so it does not claim Mean's upgrades.

Hot updates keep the Mean socket alive. After restarting the dev server, reload the page: this middleware subscribes to no HMR reconnect events and adds no polling.

`dev` must be exactly `true`, so the example above needs `NODE_ENV=development`; `NODE_ENV=production` always disables Mean. Keep the import and the HTML tag in development server code: an inert middleware call does not remove its bytes from a production bundle.
