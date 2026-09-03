import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { DuckGraphClient } from "./client";

let activePanel: vscode.WebviewPanel | null = null;

export async function showOrbitGraph(context: vscode.ExtensionContext, client: DuckGraphClient): Promise<void> {
  let graph: unknown;
  try {
    graph = await client.orbitGraph();
  } catch (error) {
    throw new Error(`CodeGraph orbit query failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isOrbitGraph(graph)) {
    throw new Error("CodeGraph daemon returned a malformed orbit graph.");
  }
  if (activePanel) {
    try {
      activePanel.reveal(vscode.ViewColumn.Beside);
      activePanel.webview.html = html(nonce(), panelD3Uri(context, activePanel), graph);
      activePanel.title = "CodeGraph Orbit";
      return;
    } catch {
      activePanel = null;
    }
  }
  const panel = vscode.window.createWebviewPanel(
    "codegraphOrbit",
    "CodeGraph Orbit",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      retainContextWhenHidden: true
    }
  );
  activePanel = panel;
  panel.onDidDispose(() => {
    if (activePanel === panel) activePanel = null;
  });
  panel.webview.html = html(nonce(), panelD3Uri(context, panel), graph);
}

function panelD3Uri(context: vscode.ExtensionContext, panel: vscode.WebviewPanel): vscode.Uri {
  return panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "d3.min.js"));
}

function nonce(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "");
  } catch {
    return String(Date.now()) + Math.random().toString(16).slice(2);
  }
}

function isOrbitGraph(value: unknown): value is { nodes: unknown[]; edges: unknown[] } {
  if (!value || typeof value !== "object") return false;
  const v = value as { nodes?: unknown; edges?: unknown };
  return Array.isArray(v.nodes) && Array.isArray(v.edges);
}

function html(n: string, d3Uri: vscode.Uri, graph: unknown): string {
  const graphJson = JSON.stringify(graph).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
  <title>CodeGraph Orbit</title>
  <style>
    html, body, svg { width: 100%; height: 100%; margin: 0; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
    svg { cursor: move; }
    .link { stroke: var(--vscode-descriptionForeground); stroke-opacity: 0.45; }
    .link.inferred { stroke-dasharray: 4 3; stroke: var(--vscode-editorWarning-foreground); }
    .node circle { fill: var(--vscode-button-background); stroke: var(--vscode-editor-background); stroke-width: 2; cursor: grab; }
    .node circle:active { cursor: grabbing; }
    .node text { fill: var(--vscode-editor-foreground); font-size: 12px; pointer-events: none; }
    .empty { display: grid; height: 100vh; place-items: center; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <svg role="img" aria-label="CodeGraph Orbit graph"></svg>
  <script nonce="${n}" src="${d3Uri}"></script>
  <script nonce="${n}">
    const graph = ${graphJson};
    const svg = d3.select("svg");
    const width = Math.max(document.body.clientWidth, 640);
    const height = Math.max(document.body.clientHeight, 480);
    
    // Create a zoomable container group
    const container = svg.append("g");
    
    // Register Zoom & Pan behaviors
    const zoom = d3.zoom()
      .scaleExtent([0.1, 8])
      .on("zoom", (event) => {
        container.attr("transform", event.transform);
      });
    svg.call(zoom);

    if (!graph.nodes.length) {
      document.body.innerHTML = '<div class="empty">No graph nodes indexed yet.</div>';
    } else {
      const links = graph.edges.map(d => ({...d}));
      const nodes = graph.nodes.map(d => ({...d}));
      const simulation = d3.forceSimulation(nodes)
        .force("link", d3.forceLink(links).id(d => d.id).distance(120))
        .force("charge", d3.forceManyBody().strength(-360))
        .force("center", d3.forceCenter(width / 2, height / 2))
        .force("collide", d3.forceCollide(42));

      const link = container.append("g").selectAll("line")
        .data(links).join("line")
        .attr("class", d => "link " + d.confidence)
        .attr("stroke-width", 1.5);

      const node = container.append("g").selectAll("g")
        .data(nodes).join("g")
        .attr("class", "node")
        .call(drag(simulation));

      node.append("circle").attr("r", d => d.freshness === "STALE" ? 11 : 8);
      node.append("title").text(d => d.name + "\\n" + d.kind + "\\n" + d.file);
      node.append("text").attr("x", 13).attr("y", 4).text(d => d.name);

      simulation.on("tick", () => {
        link.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
        node.attr("transform", d => "translate(" + d.x + "," + d.y + ")");
      });
    }

    function drag(simulation) {
      return d3.drag()
        .on("start", (event, d) => { 
          if (!event.active) simulation.alphaTarget(0.3).restart(); 
          d.fx = d.x; 
          d.fy = d.y; 
        })
        .on("drag", (event, d) => { 
          d.fx = event.x; 
          d.fy = event.y; 
        })
        .on("end", (event, d) => { 
          if (!event.active) simulation.alphaTarget(0); 
          d.fx = null; 
          d.fy = null; 
        });
    }
  </script>
</body>
</html>`;
}
