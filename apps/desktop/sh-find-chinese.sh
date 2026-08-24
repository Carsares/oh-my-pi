#!/bin/bash

# Script to find Chinese text in code comments and markdown files
# Usage: ./sh-find-chinese.sh [--translate]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse command line arguments
TRANSLATE_MODE=false
if [[ "$1" == "--translate" ]]; then
    TRANSLATE_MODE=true
fi

echo -e "${GREEN}=== Finding Chinese text in comments and markdown files ===${NC}"
echo ""

# Chinese character regex pattern
# Matches any line containing Chinese characters (CJK Unified Ideographs)
# Covers common Chinese characters including simplified and traditional forms
CHINESE_PATTERN='[一-龥\x{4e00}-\x{9fff}]'

# Function to check if file should be ignored based on .gitignore patterns
should_ignore() {
    local file="$1"

    # Common patterns from .gitignore
    if [[ "$file" =~ node_modules ]] || \
       [[ "$file" =~ /dist/ ]] || \
       [[ "$file" =~ /target/ ]] || \
       [[ "$file" =~ \.next/ ]] || \
       [[ "$file" =~ /build/ ]] || \
       [[ "$file" =~ /coverage/ ]] || \
       [[ "$file" =~ \.git/ ]] || \
       [[ "$file" =~ /output/ ]] || \
       [[ "$file" =~ /chroma/ ]] || \
       [[ "$file" =~ test-results/ ]] || \
       [[ "$file" =~ playwright-report/ ]] || \
       [[ "$file" =~ allure-results/ ]] || \
       [[ "$file" =~ \.yarn/ ]] || \
       [[ "$file" =~ \.pnp ]] || \
       [[ "$file" =~ \.log$ ]] || \
       [[ "$file" =~ \.tsbuildinfo$ ]] || \
       [[ "$file" =~ /plans/ ]] || \
       [[ "$file" =~ /packages/aic-ui/locales/ ]] || \
       [[ "$file" =~ locales/ ]] || \
       [[ "$file" =~ routeTree\.gen\.ts$ ]] || \
       [[ "$file" =~ locales/.*\.js$ ]] || \
       [[ "$file" =~ /sh-find-chinese\.sh$ ]] || \
       [[ "$file" =~ locale-source/ ]] || \
       [[ "$file" =~ \.claude/settings\.local\.json$ ]]; then
        return 0  # Should ignore
    fi
    return 1  # Should not ignore
}

# Counter for findings
total_findings=0

echo -e "${YELLOW}Searching for Chinese text...${NC}"
echo ""

# Find all relevant files (code files and markdown)
# Supported extensions: .ts, .tsx, .js, .jsx, .vue, .py, .java, .go, .rs, .c, .cpp, .h, .hpp, .sh, .md
file_extensions=(
    "ts" "tsx" "js" "jsx" "vue" "py" "java" "go" "rs"
    "c" "cpp" "h" "hpp" "sh" "md" "yaml" "yml" "json" "config"
)

# Build find command for all extensions
find_args=()
for ext in "${file_extensions[@]}"; do
    if [ ${#find_args[@]} -eq 0 ]; then
        find_args+=("-name" "*.$ext")
    else
        find_args+=("-o" "-name" "*.$ext")
    fi
done

# Search for files with Chinese characters
file_count=0
checked_files=0
perl_calls=0

# Use find with prune to efficiently skip ignored directories
while IFS= read -r file; do
    ((checked_files++)) || true

    # Skip Chinese-language documentation files, i18n package, and specific manifest files
    if [[ "$file" =~ /docs/.*\.zh\.md$ ]] || \
       [[ "$file" =~ /sdk/i18n/ ]] || \
       [[ "$file" =~ /packages/playground/src/docs/docsManifest\.ts$ ]] || \
       [[ "$file" =~ /README\.zh\.md$ ]] || \
       [[ "$file" =~ /public/locales/zh\.json$ ]] || \
       [[ "$file" =~ /public/locales/ja\.json$ ]]; then
        continue
    fi

    # Check if file contains Chinese characters (using perl for macOS compatibility)
    if perl -e 'use utf8; binmode STDIN, ":utf8"; while (<>) { if (/[\x{4E00}-\x{9FFF}]/) { exit 0; } } exit 1;' < "$file" 2>/dev/null; then
        ((perl_calls++)) || true
        ((file_count++)) || true

        echo -e "${BLUE}Found Chinese text in: ${file}${NC}"

        # Extract lines with Chinese text and show line numbers (using perl)
        perl -e 'use utf8; binmode STDIN, ":utf8"; binmode STDOUT, ":utf8"; while (<>) { print "$.: $_" if /[\x{4E00}-\x{9FFF}]/; }' < "$file" 2>/dev/null | while IFS=: read -r line_num line_content; do
            ((perl_calls++)) || true
            # Trim and display the line
            trimmed_content=$(echo "$line_content" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
            echo "  Line $line_num: $trimmed_content"
            ((total_findings++)) || true
        done

        echo ""
    fi
done < <(find . -type d \( \
    -name "node_modules" -o \
    -name "dist" -o \
    -name "build" -o \
    -name ".next" -o \
    -name "coverage" -o \
    -name ".git" -o \
    -name "output" -o \
    -name "chroma" -o \
    -name "target" -o \
    -name "test-results" -o \
    -name "playwright-report" -o \
    -name "allure-results" -o \
    -name "plans" -o \
    -name "locale-source" -o \
    -path "./packages/aic-ui/locales" -o \
    -name ".claude" -o \
    -name ".yarn" -o \
    -name ".pnp" \
\) -prune -o -type f \( "${find_args[@]}" \) -print)

# Summary
echo ""
echo -e "${GREEN}=== Summary ===${NC}"
echo "Total files with Chinese text: $file_count"
echo "Total lines with Chinese text: $total_findings"

# Translation mode
if [ "$TRANSLATE_MODE" = true ]; then
    echo ""
    echo -e "${YELLOW}=== Translation Mode ===${NC}"
    echo "Translation feature requires AI integration."
    echo "You can use Claude Code or another AI tool to translate the findings above."
    echo ""
    echo "Example workflow:"
    echo "1. Review the console output for Chinese text locations"
    echo "2. Use an AI assistant to translate specific lines"
    echo "3. Apply the translations back to the source files"
fi

echo ""
echo -e "${GREEN}Done!${NC}"
