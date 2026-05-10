import React, { useEffect, useMemo, useState } from "react";

// API tab — renders the live OpenAPI spec the server hosts at
// /api/openapi.json. Hand-rolled (rather than embedding swagger-ui)
// so the styling matches the rest of the dashboard.

const METHOD_TONE = {
  GET: "method-get",
  POST: "method-post",
  PUT: "method-put",
  PATCH: "method-patch",
  DELETE: "method-delete",
};

const TAG_LABELS = {
  system: "System",
  read: "Read",
  write: "Write",
  io: "Bulk import / export",
};

function MethodBadge({ method }) {
  const cls = METHOD_TONE[method.toUpperCase()] || "method-get";
  return <span className={`a-method ${cls}`}>{method.toUpperCase()}</span>;
}

function CodeBlock({ children }) {
  return (
    <pre className="a-code">
      <code>{children}</code>
    </pre>
  );
}

function ParamRow({ p }) {
  const required = p.required ? "required" : "";
  const schema = p.schema || {};
  const type =
    schema.type ||
    (schema.$ref ? schema.$ref.split("/").pop() : "any");
  return (
    <tr>
      <td className="a-mono">{p.name}</td>
      <td className="a-dim">{p.in}</td>
      <td className="a-mono a-dim">{type}</td>
      <td>
        {required && <span className="a-badge a-badge-warn">required</span>}{" "}
        {p.description || schema.description || ""}
      </td>
    </tr>
  );
}

function ResponseRow({ code, resp }) {
  const content = resp.content || {};
  const types = Object.keys(content);
  return (
    <tr>
      <td className="a-mono">{code}</td>
      <td>{resp.description || ""}</td>
      <td className="a-mono a-dim">{types.join(", ") || "—"}</td>
    </tr>
  );
}

function tryItUrl(serverUrl, path, parameters) {
  // Build a curl example. Query params are appended as ?key={key};
  // path params are already in the path string.
  let url = `${serverUrl}${path}`;
  const queryPairs = [];
  for (const p of parameters || []) {
    if (p && p.in === "query" && p.name) {
      queryPairs.push(`${p.name}={${p.name}}`);
    }
  }
  if (queryPairs.length) url += `?${queryPairs.join("&")}`;
  return url;
}

function curlFor(method, urlTemplate, body) {
  const parts = [`curl -X ${method.toUpperCase()}`, `"${urlTemplate}"`];
  if (body) {
    parts.push(`\\\n  -H "Content-Type: application/json"`);
    parts.push(`\\\n  -d '${JSON.stringify(body, null, 2)}'`);
  }
  return parts.join(" ");
}

function exampleBody(operation) {
  const rb = operation.requestBody;
  if (!rb || !rb.content) return null;
  // Prefer JSON if available.
  const json = rb.content["application/json"];
  if (!json) return null;
  return json.example || (json.schema && json.schema.example) || {};
}

/// Walk a `#/components/<bucket>/<name>` JSON pointer against the spec
/// and return the resolved object, or `null` if it doesn't exist.
function resolveRef(spec, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  const segs = ref.slice(2).split("/");
  let cur = spec;
  for (const s of segs) {
    if (cur == null || typeof cur !== "object") return null;
    cur = cur[s];
  }
  return cur || null;
}

function resolveParams(params, spec) {
  return (params || [])
    .map((p) => (p && p.$ref ? resolveRef(spec, p.$ref) : p))
    .filter(Boolean);
}

function Endpoint({ path, method, op, serverUrl, spec }) {
  const [open, setOpen] = useState(false);
  const params = useMemo(
    () => resolveParams(op.parameters, spec),
    [op.parameters, spec],
  );
  const responses = op.responses || {};
  const body = exampleBody(op);
  const url = tryItUrl(serverUrl, path, params);
  const curl = curlFor(method, url, body);

  return (
    <div className={`a-endpoint ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="a-endpoint-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <MethodBadge method={method} />
        <span className="a-endpoint-path a-mono">{path}</span>
        <span className="a-endpoint-summary">{op.summary || ""}</span>
        <span className="a-endpoint-toggle">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="a-endpoint-body">
          {op.description && <p className="a-dim">{op.description}</p>}

          {params.length > 0 && (
            <>
              <div className="a-section-label">Parameters</div>
              <table className="a-table a-api-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>In</th>
                    <th>Type</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {params.map((p) => (
                    <ParamRow key={`${p.name}-${p.in}`} p={p} />
                  ))}
                </tbody>
              </table>
            </>
          )}

          {body && (
            <>
              <div className="a-section-label">Request body</div>
              <CodeBlock>{JSON.stringify(body, null, 2)}</CodeBlock>
            </>
          )}

          <div className="a-section-label">Responses</div>
          <table className="a-table a-api-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Description</th>
                <th>Content-Type</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(responses).map(([code, resp]) => (
                <ResponseRow key={code} code={code} resp={resp} />
              ))}
            </tbody>
          </table>

          <div className="a-section-label">Example</div>
          <CodeBlock>{curl}</CodeBlock>
        </div>
      )}
    </div>
  );
}

function endpointsByTag(spec) {
  const groups = {};
  const paths = spec.paths || {};
  for (const [pathKey, item] of Object.entries(paths)) {
    for (const method of [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "options",
      "head",
    ]) {
      const op = item[method];
      if (!op) continue;
      const tags = op.tags && op.tags.length ? op.tags : ["other"];
      for (const tag of tags) {
        groups[tag] = groups[tag] || [];
        groups[tag].push({ path: pathKey, method, op });
      }
    }
  }
  for (const tag of Object.keys(groups)) {
    groups[tag].sort((a, b) =>
      a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
    );
  }
  return groups;
}

export function ApiRoute() {
  const [spec, setSpec] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/openapi.json")
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json();
      })
      .then(setSpec)
      .catch((e) => setError(e.message));
  }, []);

  const groups = useMemo(() => (spec ? endpointsByTag(spec) : {}), [spec]);
  const serverUrl = useMemo(() => {
    if (!spec) return "";
    const s = (spec.servers && spec.servers[0]) || { url: "/" };
    return s.url === "/" ? `${window.location.origin}` : s.url;
  }, [spec]);

  if (error) {
    return (
      <section className="a-card a-api-error">
        <h2>API spec failed to load</h2>
        <p className="a-dim">{error}</p>
        <p>Try refreshing the page; the spec is served at /api/openapi.json.</p>
      </section>
    );
  }
  if (!spec) {
    return (
      <section className="a-card">
        <p className="a-dim">Loading API spec…</p>
      </section>
    );
  }

  const orderedTags = ["system", "read", "write", "io"].filter(
    (t) => groups[t],
  );
  const otherTags = Object.keys(groups).filter(
    (t) => !orderedTags.includes(t),
  );
  const allTags = [...orderedTags, ...otherTags];

  return (
    <section className="a-api-route">
      <header className="a-card a-api-intro">
        <h1>API</h1>
        <p className="a-dim">
          {spec.info?.description ||
            "Local HTTP API for the Token Dashboard."}
        </p>
        <div className="a-api-meta">
          <span>
            <strong>Version:</strong> {spec.info?.version}
          </span>
          <span>
            <strong>Base URL:</strong> <code className="a-mono">{serverUrl}</code>
          </span>
          <span>
            <strong>Spec:</strong>{" "}
            <a href="/api/openapi.json" target="_blank" rel="noreferrer">
              /api/openapi.json
            </a>
          </span>
        </div>
        <p className="a-dim a-api-note">
          Everything runs locally. There is no auth — the server binds
          127.0.0.1 by default. Point Insomnia / Bruno / Postman / curl
          at the spec URL above to import the full surface.
        </p>
      </header>

      {allTags.map((tag) => (
        <section key={tag} className="a-card a-api-group">
          <h2>{TAG_LABELS[tag] || tag}</h2>
          <div className="a-api-endpoints">
            {groups[tag].map((e) => (
              <Endpoint
                key={`${e.method}-${e.path}`}
                path={e.path}
                method={e.method}
                op={e.op}
                serverUrl={serverUrl}
                spec={spec}
              />
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}
