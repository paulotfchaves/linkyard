# Railway service configuration

Each service points at its own config file through the service's
`railwayConfigFile` setting:

| Service | Config file | Dockerfile |
|---|---|---|
| `linkyard-demo` (panel) | `railway.panel.json` | `panel/Dockerfile` |
| `linkyard-edge` | `railway.edge.json` | `edge/Dockerfile` |

There is deliberately no `railway.json` at the root. With one there, both
services read it, and the second service silently builds the first one's
image — which is exactly what happened once: the edge deployed, answered
`/healthz` with a React Router 404, and looked like a broken edge rather than
a running panel.
