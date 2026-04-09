"use client";

import React, { useEffect, useRef, useMemo } from "react";
import type { MoveClassification } from "@/lib/analysis";

export interface UnifiedNode {
  uci: string;
  san: string;
  fen: string;
  ply: number;
  timeSpentMs: number | null;
  children: UnifiedNode[];
}

interface MoveTreeProps {
  rootNode: UnifiedNode;
  activePath: string[];
  onSelectPath: (path: string[]) => void;
  nodeClassifications?: Record<string, MoveClassification>;
}

function formatMoveTime(timeSpentMs: number | null): string | null {
  if (timeSpentMs === null) return null;
  const sec = timeSpentMs / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const mins = Math.floor(sec / 60);
  const secs = Math.round(sec % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

const renderTree = (
  nodes: UnifiedNode[],
  parentPath: string[],
  activePathJoined: string,
  onSelectPath: (path: string[]) => void,
  nodeClassifications?: Record<string, MoveClassification>,
  depth = 0,
  isBranch = false
): React.ReactNode => {
  if (nodes.length === 0) return null;

  // nodes[0] is the primary continuation. nodes[1..] are alternatives.
  const mainContinuation = [];
  let curr: UnifiedNode | null = nodes[0];
  while (curr) {
    mainContinuation.push(curr);
    curr = curr.children[0] ?? null;
  }

  const elements: React.ReactNode[] = [];

  // Provide a block wrapper for alternative branches
  const Container = isBranch ? "div" : React.Fragment;
  const containerProps = isBranch
    ? {
        style: {
          paddingLeft: "12px",
          borderLeft: "2px solid #3c3a38",
          marginTop: "4px",
          marginBottom: "4px",
          display: "flex",
          flexWrap: "wrap" as const,
          gap: "4px",
          alignItems: "center",
          background: "rgba(0,0,0,0.1)",
          borderRadius: "0 4px 4px 0",
          paddingTop: "2px",
          paddingBottom: "2px",
        },
      }
    : {};

  let mainContent: React.ReactNode[] = [];

  for (let i = 0; i < mainContinuation.length; i++) {
    const node = mainContinuation[i];
    const nodePath = [...parentPath, ...mainContinuation.slice(0, i + 1).map((n) => n.uci)];
    const nodePathJoined = nodePath.join(",");
    const isActive = activePathJoined === nodePathJoined || activePathJoined.startsWith(nodePathJoined + ",");
    const isExactlyActive = activePathJoined === nodePathJoined;

    const moveNum = Math.floor((node.ply + 1) / 2);
    const isWhite = node.ply % 2 === 1;
    const showNumber = isWhite || i === 0;

    const nodeClassification = nodeClassifications ? nodeClassifications[nodePathJoined] : "none";
    let mark = "";
    let markColor = "";
    if (nodeClassification === "brilliant") { mark = "!!"; markColor = "#1baca6"; } // Teal
    else if (nodeClassification === "great") { mark = "!"; markColor = "#5ca0d3"; } // Blue
    else if (nodeClassification === "blunder") { mark = "??"; markColor = "#f05149"; } // Red
    else if (nodeClassification === "mistake") { mark = "?"; markColor = "#e8802a"; } // Orange
    else if (nodeClassification === "inaccuracy") { mark = "?!"; markColor = "#ebba34"; } // Yellow
    else if (nodeClassification === "miss") { mark = "✖"; markColor = "#f05149"; } // Red X
    else if (nodeClassification === "best") { mark = "★"; markColor = "#81b64c"; } // Green Star
    else if (nodeClassification === "excellent") { mark = "!"; markColor = "#96bc4b"; } // Light Green
    else if (nodeClassification === "good") { mark = "✓"; markColor = "#96bc4b"; } // Light Green
    else if (nodeClassification === "book") { mark = "📖"; markColor = "#b09f87"; } // Book

    mainContent.push(
      <button
        key={nodePathJoined}
        data-active={isExactlyActive ? "true" : undefined}
        onClick={() => onSelectPath(nodePath)}
        style={{
          background: isExactlyActive ? "#4d4a45" : "transparent",
          color: isExactlyActive ? "#fff" : isActive ? "#e0dcd7" : "#a9a5a1",
          border: "none",
          padding: "2px 5px",
          borderRadius: "4px",
          cursor: "pointer",
          fontSize: "13px",
          fontWeight: isExactlyActive ? "bold" : "normal",
          fontFamily: "inherit",
          display: "inline-flex",
          alignItems: "center",
          marginBottom: "2px"
        }}
      >
        {showNumber && <span style={{ color: "#7a7672", marginRight: "4px", fontSize: "11px" }}>{moveNum}{isWhite ? "." : "..."}</span>}
        <span>{node.san}</span>
        {mark && <span style={{ color: markColor, marginLeft: "1px", fontWeight: 800 }}>{mark}</span>}
        {node.timeSpentMs !== null && !isBranch && (
          <span style={{ marginLeft: "4px", fontSize: "10px", color: "#6f6a64" }}>
            {formatMoveTime(node.timeSpentMs)}
          </span>
        )}
      </button>
    );

    // Render alternative branches that sprouted FROM THIS node's parent (where this node is the main continuation)
    if (i > 0) {
      const prevNode = mainContinuation[i - 1];
      if (prevNode.children.length > 1) {
        for (let j = 1; j < prevNode.children.length; j++) {
          const altNode = prevNode.children[j];
          const altPath = [...parentPath, ...mainContinuation.slice(0, i).map(n => n.uci)];
          mainContent.push(
            <div key={`alt-${altPath.join(",")}-${altNode.uci}`} style={{ width: "100%" }}>
              {renderTree([altNode], altPath, activePathJoined, onSelectPath, nodeClassifications, depth + 1, true)}
            </div>
          );
        }
      }
    }
  }

  return (
    <Container {...containerProps}>
      {mainContent}
    </Container>
  );
};

export default function MoveTree({ rootNode, activePath, onSelectPath, nodeClassifications }: MoveTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activePathJoined = activePath.join(",");

  useEffect(() => {
    // Auto-scroll to active node
    if (!containerRef.current) return;
    const activeEl = containerRef.current.querySelector("[data-active='true']");
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activePathJoined]);

  return (
    <div
      ref={containerRef}
      style={{
        display: "flex",
        flexDirection: "column",
        padding: "8px 12px",
        fontSize: "14px",
        color: "#ddd",
        background: "#211f1c",
        height: "100%",
        overflowY: "auto",
        alignItems: "flex-start",
        alignContent: "flex-start",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px", alignItems: "center", width: "100%" }}>
        {renderTree(rootNode.children, [], activePathJoined, onSelectPath, nodeClassifications)}
        {rootNode.children.length > 1 && rootNode.children.slice(1).map((altNode) => (
          <div key={`root-alt-${altNode.uci}`} style={{ width: "100%" }}>
            {renderTree([altNode], [], activePathJoined, onSelectPath, nodeClassifications, 1, true)}
          </div>
        ))}
      </div>
    </div>
  );
}
