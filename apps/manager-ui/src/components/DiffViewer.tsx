import React from "react";

export interface DiffViewerProps {
  diff: string;
}

export function DiffViewer({ diff }: DiffViewerProps) {
  if (!diff) {
    return null;
  }

  const lines = diff.split("\n");

  return (
    <div className="overflow-x-auto rounded border border-[#30363d] bg-[#0d1117] py-1 my-1">
      {lines.map((line, index) => {
        if (line.startsWith("+")) {
          return (
            <div
              key={index}
              className="bg-green-950/40 text-green-400 font-mono text-sm px-2 whitespace-pre"
            >
              {line}
            </div>
          );
        }

        if (line.startsWith("-")) {
          return (
            <div
              key={index}
              className="bg-red-950/40 text-red-400 font-mono text-sm px-2 whitespace-pre"
            >
              {line}
            </div>
          );
        }

        return (
          <div
            key={index}
            className="text-gray-300 font-mono text-sm px-2 whitespace-pre"
          >
            {line}
          </div>
        );
      })}
    </div>
  );
}
