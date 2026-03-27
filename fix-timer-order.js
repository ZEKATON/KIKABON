const fs = require('fs');

let content = fs.readFileSync('player.js', 'utf8');

// Fix the insertion - move showScreen call before the timer
const broken = `    
    // Auto-transition après 30 secondes si final
    if (isFinal) {
      if (window.podiumTimeout) clearTimeout(window.podiumTimeout);
      window.podiumTimeout = setTimeout(() => {
        const currentScreen = getActiveScreenId();
        if (currentScreen === 'screen-podium') {
          returnToJoinScreen();
        }
      }, 30000);
    }
    showScreen('screen-podium');`;

const fixed = `    showScreen('screen-podium');
    
    // Auto-transition après 30 secondes si final
    if (isFinal) {
      if (window.podiumTimeout) clearTimeout(window.podiumTimeout);
      window.podiumTimeout = setTimeout(() => {
        const currentScreen = getActiveScreenId();
        if (currentScreen === 'screen-podium') {
          returnToJoinScreen();
        }
      }, 30000);
    }`;

if (content.includes(broken)) {
  content = content.replace(broken, fixed);
  fs.writeFileSync('player.js', content);
  console.log('✅ Fixed timer code order - showScreen now called first');
} else {
  console.log('⚠ Could not find broken pattern to fix');
}
