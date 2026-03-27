const fs = require('fs');

let content = fs.readFileSync('player.js', 'utf8');
const lines = content.split('\n');
let newLines = [];
let found = false;

for (let i = 0; i < lines.length; i++) {
  newLines.push(lines[i]);
  
  // Look for showScreen('screen-podium'); and add timer after it
  if (!found && lines[i].includes("showScreen('screen-podium');") && 
      i > 0 && lines[i-2].includes('statEl.style.display')) {
    // Add blank line and the timer code
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
    found = true;
    console.log('Added timer code');
  }
}

if (found) {
  fs.writeFileSync('player.js', newLines.join('\n'));
  console.log('✅ Successfully added 30-second auto-transition timer');
} else {
  console.log('⚠ Could not find the exact pattern');
}
