const fs = require('fs');

let content = fs.readFileSync('player.js', 'utf8');
const lines = content.split('\n');
let newLines = [];

// We know function showPodium is at line 1603 (0-indexed: 1602)
// and showScreen('screen-podium'); is at line 1655 (0-indexed: 1654)
// Let's just insert after line 1654 (0-indexed)

const insertAfterLineIndex = 1654; // Line 1655 in 1-indexed

for (let i = 0; i < lines.length; i++) {
  newLines.push(lines[i]);
  
  if (i === insertAfterLineIndex) {
    newLines.push('    ');
    newLines.push('    // Auto-transition après 30 secondes si final');
    newLines.push('    if (isFinal) {');
    newLines.push('      if (window.podiumTimeout) clearTimeout(window.podiumTimeout);');
    newLines.push('      window.podiumTimeout = setTimeout(() => {');
    newLines.push('        const currentScreen = getActiveScreenId();');
    newLines.push('        if (currentScreen === \'screen-podium\') {');
    newLines.push('          returnToJoinScreen();');
    newLines.push('        }');
    newLines.push('      }, 30000);');
    newLines.push('    }');
  }
}

fs.writeFileSync('player.js', newLines.join('\n'));
console.log('✅ Successfully added 30-second auto-transition timer');
