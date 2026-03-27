const fs = require('fs');

let content = fs.readFileSync('player.js', 'utf8');

// Find the line "showScreen('screen-podium');" and add code after it
const lines = content.split('\n');
let newLines = [];
let found = false;

for (let i = 0; i < lines.length; i++) {
  newLines.push(lines[i]);
  
  // Look for the line that contains showScreen('screen-podium') within showPodium function
  // We can identify it by looking back a few lines for "statEl.style.display"
  if (!found && lines[i].includes("showScreen('screen-podium');") && 
      i > 0 && lines[i-1].includes('statEl.style.display')) {
    // Insert the timer code after this line
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
  }
}

if (found) {
  fs.writeFileSync('player.js', newLines.join('\n'));
  console.log('✅ Added 30-second auto-transition timer');
} else {
  console.log('❌ Could not find showScreen line after statEl.style.display');
  process.exit(1);
}
