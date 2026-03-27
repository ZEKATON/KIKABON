const fs = require('fs');

let content = fs.readFileSync('player.js', 'utf8');
const lines = content.split('\n');
let newLines = [];
let found = false;

// Find the showScreen line that's in showPodium, not elsewhere
// We know it's at line 1655 based on debug output
let targetIndex = -1;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("showScreen('screen-podium');")) {
    // This should be the only one around this position, but let's verify
    // Look back to see if we're in showPodium context
    let inShowPodium = false;
    for (let j = i - 1; j >= Math.max(0, i - 50); j--) {
      if (lines[j].includes('function showPodium(')) {
        inShowPodium = true;
        break;
      }
      if (lines[j].includes('function show') && !lines[j].includes('showPodium')) {
        break;
      }
    }
    
    if (inShowPodium && !found) {
      targetIndex = i;
      found = true;
      break;
    }
  }
}

if (targetIndex >= 0) {
  // Rebuild lines with timer code inserted
  for (let i = 0; i < lines.length; i++) {
    newLines.push(lines[i]);
    
    if (i === targetIndex) {
      // Add the timer code
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
  console.log('✅ Successfully added 30-second auto-transition timer at line ' + (targetIndex + 1));
} else {
  console.log('❌ Could not find showScreen in showPodium function');
}
