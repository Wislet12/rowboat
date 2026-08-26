import {
  FileQuestion,
  GitCompareArrows,
  GraduationCap,
  ListChecks,
  Sparkles,
  TimerReset,
  type LucideIcon,
} from 'lucide-react'

export type NotebookArtifactAction = {
  icon: LucideIcon
  label: string
  description: string
  prompt: string
}

// Notebook Studio and Study intentionally share this catalog. Keeping one
// prompt source preserves the existing NotebookLM-style tools while Study
// provides the more organized education-facing entry point.
export const NOTEBOOK_ARTIFACTS: readonly NotebookArtifactAction[] = [
  {
    icon: Sparkles,
    label: 'Source summary',
    description: 'Key ideas and evidence with citations.',
    prompt: 'Summarize the selected notebook sources. Organize the key ideas clearly and cite every factual claim with [S#].',
  },
  {
    icon: GraduationCap,
    label: 'Study guide',
    description: 'Concepts, definitions, and review questions.',
    prompt: 'Create a comprehensive study guide from the selected notebook sources with key concepts, definitions, memory cues, and review questions. Cite each section with [S#].',
  },
  {
    icon: FileQuestion,
    label: 'FAQ',
    description: 'Important questions answered from the sources.',
    prompt: 'Create an FAQ from the selected notebook sources. Answer only from the material and cite each answer with [S#].',
  },
  {
    icon: TimerReset,
    label: 'Timeline',
    description: 'Dates, events, and dependencies in order.',
    prompt: 'Build a chronological timeline from the selected notebook sources. Include dates, events, dependencies, uncertainty, and [S#] citations.',
  },
  {
    icon: GitCompareArrows,
    label: 'Compare sources',
    description: 'Agreements, differences, and contradictions.',
    prompt: 'Compare the selected notebook sources. Identify agreements, differences, contradictions, and gaps with precise [S#] citations.',
  },
  {
    icon: ListChecks,
    label: 'Quiz me',
    description: 'An interactive source-grounded knowledge check.',
    prompt: 'Quiz me interactively on the selected notebook sources. Ask one question at a time, wait for my answer, then explain it with [S#] citations.',
  },
] as const
