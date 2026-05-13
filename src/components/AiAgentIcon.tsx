import type { ImgHTMLAttributes } from "react";
import claudeIcon from "../assets/ai-agents/claude.svg";
import codexIcon from "../assets/ai-agents/codex.svg";
import geminiIcon from "../assets/ai-agents/gemini.svg";
import ollamaIcon from "../assets/ai-agents/ollama.svg";
import type { AiAgent } from "../lib/types";

const ICON_SRC: Record<AiAgent, string> = {
  claude: claudeIcon,
  codex: codexIcon,
  gemini: geminiIcon,
  ollama: ollamaIcon,
};

interface AiAgentIconProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> {
  agent: AiAgent;
  alt?: string;
}

export function AiAgentIcon({ agent, alt = "", className, ...props }: AiAgentIconProps) {
  return (
    <img
      src={ICON_SRC[agent]}
      alt={alt}
      className={["rounded-[2px] bg-white p-[1px]", className]
        .filter(Boolean)
        .join(" ")}
      draggable={false}
      {...props}
    />
  );
}
