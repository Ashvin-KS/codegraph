import * as vscode from "vscode";
import type { DuckGraphClient } from "./client";

export async function showOrbitGraph(context: vscode.ExtensionContext, client: DuckGraphClient): Promise<void> {
  const graph = await client.orbitGraph();
  const panel = vscode.window.createWebviewPanel(
    "duckgraphOrbit",
    "DuckGraph Orbit",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")]
    }
  );
  const nonce = String(Date.now()) + Math.random().toString(16).slice(2);
  const d3Uri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "d3.min.js"));
  panel.webview.html = html(nonce, d3Uri, graph);
}

function html(nonce: string, d3Uri: vscode.Uri, graph: unknown): string {
  const graphJson = JSON.stringify(graph).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>DuckGraph Orbit</title>
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
  <svg role="img" aria-label="DuckGraph Orbit graph"></svg>
  <script nonce="${nonce}" src="${d3Uri}"></script>
  <script nonce="${nonce}">
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
