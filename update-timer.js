const fs = require('fs');

let content = fs.readFileSync('player.js', 'utf8');

const timerFind = `      statEl.style.display = 'flex';
    }

    showScreen('screen-podium');
  }

  function showFillScores(results) {`;

const timerReplace = `      statEl.style.display = 'flex';
    }

    showScreen('screen-podium');
    
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
  }

  function showFillScores(results) {`;

if (content.includes(timerFind)) {
  content = content.replace(timerFind, timerReplace);
  fs.writeFileSync('player.js', content);
  console.log('✅ Added 30-second auto-transition timer');
} else {
  console.log('❌ Could not find the pattern to add timer');
  process.exit(1);
}
