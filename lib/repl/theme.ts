// ANSI 16-color constants — adapts to terminal dark/light themes automatically.
// Matches the Rust teide-rs CLI theme.

// Formatting
export const BOLD = '\x1b[1m';
export const ITALIC = '\x1b[3m';
export const R = '\x1b[0m';
export const REVERSE = '\x1b[7m';

// Table structure
export const BORDER = '\x1b[90m';
export const HEADER = '\x1b[1;36m';
export const TYPE_DIM = '\x1b[90m';
export const TEXT = '\x1b[39m';
export const NULL_CLR = '\x1b[90m';
export const FOOTER = '\x1b[90m';

// Status
export const ERROR = '\x1b[1;31m';
export const SUCCESS = '\x1b[32m';
export const TIMER = '\x1b[90m';

// Banner
export const BAN_BORDER = '\x1b[34m';
export const BAN_TITLE = '\x1b[1;36m';
export const BAN_INFO = '\x1b[39m';
export const BAN_HELP = '\x1b[90m';

// Syntax highlighting
export const KW = '\x1b[1;34m';
export const FN = '\x1b[1;36m';
export const STR = '\x1b[33m';
export const NUM = '\x1b[35m';
export const OP = '\x1b[1;34m';
export const CM = '\x1b[90m';
export const DOT_CMD = '\x1b[36m';
