const fs = require('fs');

let content = fs.readFileSync('player.js', 'utf8');
let changed = false;

// Step 2: Simplify stats display by removing redundant rows
const oldStatHTML = `      statEl.innerHTML =
        '<div class="pps-main" style="color:' + pctColor + '">' + pct + '%</div>' +
        '<div class="pps-sub">de bonnes reponses</div>' +
        '<div class="pps-row">' +
          '<span class="pps-icon">🎯</span>' +
          '<span class="pps-label">Bonnes réponses</span>' +
          '<span class="pps-value" style="color:' + pctColor + '">' + correct + '/' + total + ' — ' + pct + '%</span>' +
        '</div>' +
        '<div class="pps-bar-wrap"><div class="pps-bar" style="width:' + pct + '%;background:' + pctColor + '"></div></div>' +
        '<div class="pps-row">' +
          '<span class="pps-icon">' + rankEmoji + '</span>' +
          '<span class="pps-label">Classement</span>' +
          '<span class="pps-value">' + rank + 'e&nbsp;/ ' + sorted.length + '</span>' +
        '</div>' +
        '<div class="pps-message" style="border-color:' + pctColor + '">' + encouragement + '</div>' +
        '<div class="pps-row">' +
          '<span class="pps-icon">💯</span>' +
          '<span class="pps-label">Score total</span>' +
          '<span class="pps-value">' + (me.score || 0) + ' pts</span>' +
        '</div>';`;

const newStatHTML = `      statEl.innerHTML =
        '<div class="pps-main" style="color:' + pctColor + '">' + pct + '%</div>' +
        '<div class="pps-sub">de bonnes reponses</div>' +
        '<div class="pps-bar-wrap"><div class="pps-bar" style="width:' + pct + '%;background:' + pctColor + '"></div></div>' +
        '<div class="pps-row">' +
          '<span class="pps-icon">' + rankEmoji + '</span>' +
          '<span class="pps-label">Classement ' + rank + 'e/' + sorted.length + '</span>' +
          '<span class="pps-value" style="color:' + pctColor + '">' + correct + '/' + total + '</span>' +
        '</div>' +
        '<div class="pps-message" style="border-color:' + pctColor + '">' + encouragement + '</div>';`;

if (content.includes(oldStatHTML)) {
  content = content.replace(oldStatHTML, newStatHTML);
  console.log('✓ Simplified stats display (removed redundant rows)');
  changed = true;
} else {
  console.log('⚠ Could not find old stats HTML format');
}

// Step 3: Add 30-second auto-transition timer after showScreen
const findShowScreen = `    showScreen('screen-podium');
  }

  function showFillScores(results) {`;

const replaceShowScreen = `    showScreen('screen-podium');
    
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

if (content.includes(findShowScreen)) {
  content = content.replace(findShowScreen, replaceShowScreen);
  console.log('✓ Added 30-second auto-transition timer to podium');
  changed = true;
} else {
  console.log('⚠ Could not find showScreen + showFillScores pattern');
}

if (changed) {
  fs.writeFileSync('player.js', content);
  console.log('\n✅ All changes applied successfully!');
} else {
  console.log('\n❌ No changes were made');
  process.exit(1);
}
