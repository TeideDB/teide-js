export type WindowFuncKind =
  | 'rowNumber' | 'rank' | 'denseRank' | 'ntile'
  | 'sum' | 'avg' | 'min' | 'max' | 'count'
  | 'lag' | 'lead'
  | 'firstValue' | 'lastValue' | 'nthValue';

export interface WindowFunc {
  kind: WindowFuncKind;
  col?: string;
  n?: number;       // for ntile, nthValue
  offset?: number;   // for lag, lead
}

export type FrameBound =
  | 'unboundedPreceding'
  | 'currentRow'
  | 'unboundedFollowing'
  | { preceding: number }
  | { following: number };

export interface WindowOpts {
  partitionBy: string[];
  orderBy: { col: string; descending?: boolean }[];
  funcs: WindowFunc[];
  frame?: {
    type?: 'rows' | 'range';
    start?: FrameBound;
    end?: FrameBound;
  };
}

export interface JoinOpts {
  on?: string | string[];
  leftOn?: string | string[];
  rightOn?: string | string[];
  how?: 'inner' | 'left' | 'full';
}

export interface WindowJoinOpts {
  timeKey: string;
  symKey: string;
  windowLo: number;
  windowHi: number;
  aggs: import('./expr').Expr[];
}
