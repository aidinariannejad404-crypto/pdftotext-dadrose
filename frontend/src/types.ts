// Mirrors backend/app/models.py — keep in sync.
export type BBox = [number, number, number, number];
export type DocKind = 'booklet' | 'explanations';
export type EngineName = 'auto' | 'offline' | 'claude' | 'gemini';
export type WordFlag = 'low_conf' | 'disagree';
export type Track = 'bar' | 'center' | 'other';

export interface Word {
  text: string;
  bbox: BBox | null;
  conf: number | null;
  flag: WordFlag | null;
  alt: string | null;
}

export interface Line {
  page: number;
  words: Word[];
  bbox: BBox | null;
}

export interface PageResult {
  index: number;
  width: number;
  height: number;
  source: 'text_layer' | 'ocr';
  engine: string;
  preprocess: string[];
  lines: Line[];
  warnings: string[];
}

export interface Region {
  doc: DocKind;
  page: number;
  bbox: BBox;
}

export interface Flag {
  field: string; // "stem" | "option:1".."option:4" | "explanation"
  word: string;
  doc: DocKind;
  page: number;
  bbox: BBox | null;
  reason: WordFlag;
  alt: string | null;
}

export interface Issue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  field: string | null;
}

export interface Option {
  key: string;
  text: string;
}

export interface Question {
  number: number;
  subject_key: string | null;
  stem: string;
  options: Option[];
  correct_key: string | null;
  key_source: 'table' | 'explanation' | 'manual' | null;
  explanation: string;
  regions: Region[];
  flags: Flag[];
  issues: Issue[];
  status: 'pending' | 'approved';
  edited: boolean;
}

export interface Progress {
  stage: string; // queued|rendering|ocr|parsing|done|failed
  done: number;
  total: number;
}

export interface DocInfo {
  kind: DocKind;
  filename: string;
  page_count: number;
}

export type ProjectStatus = 'queued' | 'processing' | 'ready' | 'failed';

export interface Project {
  id: string;
  title: string;
  track: Track;
  year: number | null;
  blueprint: string;
  engine: EngineName;
  created_at: string;
  status: ProjectStatus;
  progress: Progress;
  error: string | null;
  documents: DocInfo[];
  questions: Question[];
  issues: Issue[];
}

export interface ProjectSummary {
  id: string;
  title: string;
  track: string;
  year: number | null;
  created_at: string;
  status: string;
  progress: Progress;
  error: string | null;
  question_count: number;
  approved_count: number;
  error_count: number;
}

export interface QuestionUpdate {
  subject_key?: string | null;
  stem?: string | null;
  options?: Option[] | null;
  correct_key?: string | null;
  explanation?: string | null;
  status?: 'pending' | 'approved' | null;
  flags?: Flag[] | null; // full remaining list after resolving suspicious words
}

export interface Health {
  ok: boolean;
  engines: { offline: boolean; claude: boolean; gemini: boolean };
  default_engine: string;
  push_configured?: boolean;
}

export interface Blueprint {
  code: string;
  title: string;
  track: string;
  year: number | null;
  question_count: number;
}

export interface Subject {
  key: string;
  name: string;
}

export interface Meta {
  blueprints: Blueprint[];
  subjects: Subject[];
}

export interface PushResult {
  ok: boolean;
  response: unknown;
}
