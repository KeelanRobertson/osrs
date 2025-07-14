document.addEventListener("DOMContentLoaded", () => {
  // 'data/' for git version
  const baseCacheUrl = 'data/';
  const mappingUrl = baseCacheUrl + 'mapping.json';
  const cacheUrls = ['latest.json', '5m.json', '10m.json', '30m.json', '1h.json', '6h.json', '24h.json'].map(name => baseCacheUrl + name);

  let itemsById = {};
  let itemsByName = {};
  let recipes = [];

  async function loadLastFetched() {
    try {
      const res = await fetch(baseCacheUrl + 'last_fetched.json');
      if (!res.ok) throw new Error('Failed to load last fetched time');
      const data = await res.json();
      const lastFetchedDate = new Date(data.lastFetched);

      const lastFetchedTime = lastFetchedDate.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });

      const now = new Date();
      const checkedTime = now.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });

      const infoEl = document.getElementById('last-refresh-info');
      infoEl.innerHTML = `
        Last data update: ${lastFetchedTime}<br>
        Last Checked: ${checkedTime}`;

      localStorage.setItem('lastFetched', data.lastFetched);
    } catch (error) {
      console.warn('Error loading last fetched time:', error);
    }
  }

  async function shouldFetchData() {
    try {
      const res = await fetch(baseCacheUrl + 'last_fetched.json');
      if (!res.ok) throw new Error('Failed to load last fetched time');
      const data = await res.json();
      const remoteTimestamp = new Date(data.lastFetched);
      
      const localTimestampStr = localStorage.getItem('lastFetched');
      if (!localTimestampStr) return true; // no record, fetch needed

      const localTimestamp = new Date(localTimestampStr);
      return remoteTimestamp > localTimestamp; // only fetch if newer
    } catch (error) {
      console.warn('Error checking if data should be fetched:', error);
      return true; // fallback to fetching if anything goes wrong
    }
  }

  async function loadRecipes() {
    const res = await fetch(baseCacheUrl + 'recipes.json');
    recipes = await res.json();
  }

  async function fetchData() {
    const mapping = await fetch(mappingUrl).then(res => res.json());
    const priceData = await Promise.all(cacheUrls.map(url => fetch(url).then(res => res.json())));

    itemsById = {};
    itemsByName = {};

    mapping.forEach(item => {
      const id = item.id;
      const allPrices = priceData.map(d => d.data[id]).filter(Boolean);
      const highPrices = allPrices.map(d => d.avgHighPrice || d.high).filter(Boolean);
      const lowPrices = allPrices.map(d => d.avgLowPrice || d.low).filter(Boolean);
      const latest = priceData[0].data[id];

      itemsById[id] = {
        ...item,
        maxHigh: Math.max(...highPrices, 0),
        minLow: Math.min(...lowPrices, Infinity),
        currentHigh: latest?.high || 0,
        currentLow: latest?.low || 0
      };
      itemsByName[item.name.toLowerCase()] = itemsById[id];
    });
  }

  // Optional fallback in case JSON fails to load (empty = no exempt items)
  window.taxExemptFallback = {};

  let taxExemptItems = window.taxExemptFallback;

  async function loadTaxExemptItems() {
    try {
      const res = await fetch('/data/taxExemptItems.json');
      if (!res.ok) throw new Error('Network response was not ok');
      taxExemptItems = await res.json();
      console.log('Loaded tax exempt items from JSON.');
    } catch (error) {
      console.warn('Failed to load tax exempt JSON, using empty fallback.', error);
    }
  }

  function applyGEtax(price, itemName) {
    if (taxExemptItems[itemName]) return price;
    const tax = Math.min(Math.floor(price * 0.02), 5_000_000);
    return price - tax;
  }

  function calculateProfit(recipe) {
    const outputItem = itemsByName[recipe.output.item.toLowerCase()];
    const grossOutputPrice = outputItem?.maxHigh * recipe.output.quantity || 0;
    const netOutputPrice = applyGEtax(grossOutputPrice);


    const inputDetails = recipe.inputs.map(input => {
      const inputItem = itemsByName[input.item.toLowerCase()];
      const price = inputItem?.minLow || 0;
      const current = inputItem?.currentLow || 0;
      return {
        ...input,
        price,
        current,
        total: price * input.quantity
      };
    });

    const inputCost = inputDetails.reduce((sum, i) => sum + i.total, 0);
    const profit = netOutputPrice - inputCost;

    return {
      recipeName: recipe.name,
      outputItem: recipe.output.item,
      outputQuantity: recipe.output.quantity,
      outputPrice: outputItem?.maxHigh || 0,
      grossOutputPrice,
      netOutputPrice,
      currentOutputPrice: outputItem?.currentHigh || 0,
      inputDetails,
      inputCost,
      profit
    };
  }

  function displayResults() {
    const container = document.getElementById("results");
    container.innerHTML = "";

    const filterEnabled = document.getElementById("filter-by-skills")?.checked;
    const userSkills = getUserSkillLevels();
    const maxCostInput = document.getElementById("max-cost")?.value;
    const maxCost = maxCostInput ? parseInt(maxCostInput) : Infinity;

    let hiddenBySkills = 0;
    let hiddenByCost = 0;

    const visibleRecipes = recipes.filter(recipe => {
      const result = calculateProfit(recipe);
      const totalInputCost = result.inputDetails.reduce((sum, i) => sum + i.total, 0);

      // Skill filtering
      const skillPass = !filterEnabled || !recipe.requiredSkills || Object.entries(recipe.requiredSkills).every(
        ([skill, level]) => userSkills[skill] >= level
      );

      // Cost filtering
      const costPass = totalInputCost <= maxCost;

      if (!skillPass) hiddenBySkills++;
      if (skillPass && !costPass) hiddenByCost++; // Only count cost-hidden if skill passed

      return skillPass && costPass;
    });

    visibleRecipes.forEach(recipe => {
      const result = calculateProfit(recipe);
      const div = document.createElement("div");
      div.className = "profit";
      div.innerHTML = `
        <h3>${recipe.name}</h3>
        <p><strong>Current Profit:</strong> <span class="${result.profit >= 0 ? 'positive' : 'negative'}">${result.profit.toLocaleString()} gp</span></p>
        <p><strong>Sell Price of ${result.outputItem}:</strong> ${result.outputPrice.toLocaleString()} gp <em>(Current: ${result.currentOutputPrice.toLocaleString()} gp)</em></p>
        <p><strong>Input Costs:</strong></p>
        <p><strong>Total Input Cost:</strong> ${result.inputDetails.reduce((sum, i) => sum + i.total, 0).toLocaleString()} gp</p>
        <ul>
          ${result.inputDetails.map(i =>
            `<li>${i.quantity} x ${i.item} @ ${i.price.toLocaleString()} gp <em>(Current: ${i.current.toLocaleString()} gp)</em> = ${i.total.toLocaleString()} gp</li>`
          ).join('')}
        </ul>
      `;
      container.appendChild(div);
    });

    // Add hidden messages
    if (hiddenBySkills > 0 || hiddenByCost > 0) {
      const msg = document.createElement("div");
      msg.style.marginTop = "10px";
      msg.style.fontStyle = "italic";
      msg.style.color = "#888";

      const parts = [];
      if (hiddenBySkills > 0) parts.push(`${hiddenBySkills} recipe${hiddenBySkills > 1 ? "s" : ""} hidden due to level requirements`);
      if (hiddenByCost > 0) parts.push(`${hiddenByCost} recipe${hiddenByCost > 1 ? "s" : ""} hidden due to cost limit`);

      msg.textContent = parts.join(". ") + ".";
      container.appendChild(msg);
    }
  }


  function parseCustomRecipe() {
    const lines = document.getElementById("custom-recipe").value.trim().split("\n");
    const inputs = [];
    let output = null;
    for (const line of lines) {
      if (line.includes("=")) {
        const [_, right] = line.split("=");
        const [qty, ...name] = right.trim().split(" ");
        output = { item: name.join(" "), quantity: parseInt(qty) };
      } else {
        const [qty, ...name] = line.trim().split(" ");
        inputs.push({ item: name.join(" "), quantity: parseInt(qty) });
      }
    }
    return { name: "Custom Recipe", inputs, output };
  }

  function addCustomRecipe() {
    const custom = parseCustomRecipe();
    recipes.push(custom);
    displayResults();
  }

  const skillNames = [
    "Attack", "Hitpoints", "Mining", "Strength", "Agility", "Smithing", "Defence", "Herblore",
    "Fishing", "Ranged", "Thieving", "Cooking", "Prayer", "Crafting", "Firemaking", "Magic",
    "Fletching", "Woodcutting", "Runecraft", "Slayer", "Farming", "Construction", "Hunter"
  ];

  function toggleSkills() {
    const modal = document.getElementById("skills-modal");
    const style = window.getComputedStyle(modal);
    if (style.display === "none") {
      modal.style.display = "block";
    } else {
      modal.style.display = "none";
    }
  }

  function createSkillInputs() {
    const container = document.getElementById("skills-grid");
    container.innerHTML = "";

    skillNames.forEach(skill => {
      const wrapper = document.createElement("div");
      const label = document.createElement("label");
      label.textContent = skill;
      const input = document.createElement("input");
      input.type = "number";
      input.min = 1;
      input.max = 99;
      input.value = 99;
      input.style.background = "#333";
      input.style.color = "#fff";
      input.style.border = "1px solid #555";
      input.dataset.skill = skill;
      input.addEventListener("input", updateTotalLevel);
      wrapper.appendChild(label);
      wrapper.appendChild(input);
      container.appendChild(wrapper);
    });

    // Add total level box in last grid slot
    const totalWrapper = document.createElement("div");
    const label = document.createElement("label");
    label.textContent = "Total Level";
    const totalBox = document.createElement("div");
    totalBox.id = "total-level";
    totalBox.textContent = 99 * skillNames.length; // default total (all 99)
    totalWrapper.appendChild(label);
    totalWrapper.appendChild(totalBox);
    container.appendChild(totalWrapper);
  }

  function updateTotalLevel() {
    const inputs = document.querySelectorAll("#skills-grid input");
    let total = 0;
    const levels = {};
    inputs.forEach(input => {
      let val = Math.min(Math.max(parseInt(input.value) || 1, 1), 99);
      input.value = val;
      total += val;
      levels[input.dataset.skill] = val;
    });
    document.getElementById("total-level").textContent = total;

    // Save to localStorage
    localStorage.setItem("osrsSkillLevels", JSON.stringify(levels));
    // Refresh results when skills are updated
    displayResults();
  }

  async function fetchHiscores() {
    const rsn = document.getElementById("rsn").value.trim();
    const messageEl = document.getElementById("rsn-message");
    messageEl.textContent = "";  // Clear previous messages

    if (!rsn) {
      messageEl.textContent = "Please enter a username.";
      return;
    }

    try {
      const res = await fetch(`https://api.wiseoldman.net/v2/players/${encodeURIComponent(rsn)}`);

      if (!res.ok) {
        throw new Error(`Player "${rsn}" not found.`);
      }

      const data = await res.json();

      if (!data.latestSnapshot) {
        throw new Error(`No snapshot data found for player "${rsn}". Please update manually.`);
      }

      const skills = data.latestSnapshot.data.skills;
      const mapping = {
        attack: "Attack",
        defence: "Defence",
        strength: "Strength",
        hitpoints: "Hitpoints",
        ranged: "Ranged",
        prayer: "Prayer",
        magic: "Magic",
        cooking: "Cooking",
        woodcutting: "Woodcutting",
        fletching: "Fletching",
        fishing: "Fishing",
        firemaking: "Firemaking",
        crafting: "Crafting",
        smithing: "Smithing",
        mining: "Mining",
        herblore: "Herblore",
        agility: "Agility",
        thieving: "Thieving",
        slayer: "Slayer",
        farming: "Farming",
        runecrafting: "Runecraft",
        hunter: "Hunter",
        construction: "Construction"
      };

      for (const [apiName, label] of Object.entries(mapping)) {
        const level = skills[apiName]?.level ?? 1;
        const input = document.querySelector(`#skills-grid input[data-skill="${label}"]`);
        if (input) input.value = Math.min(level, 99);
      }

      updateTotalLevel();

      // Save to localStorage after fetching
      const inputs = document.querySelectorAll("#skills-grid input");
      const levels = {};
      inputs.forEach(input => {
        levels[input.dataset.skill] = parseInt(input.value) || 1;
      });
      localStorage.setItem("osrsSkillLevels", JSON.stringify(levels));

      messageEl.style.color = "#00ff00";
      messageEl.textContent = "Hiscores data loaded successfully!";

    } catch (e) {
      messageEl.style.color = "#ff5555";
      messageEl.innerHTML = `${e.message}<br>Please visit <a href="https://wiseoldman.net/players/${encodeURIComponent(rsn)}" target="_blank" rel="noopener noreferrer">https://wiseoldman.net/players/${rsn}</a> to manually update your hiscores data.`;
    }
  }

  function loadSkillLevels() {
    const savedLevels = localStorage.getItem("osrsSkillLevels");
    if (savedLevels) {
      const levels = JSON.parse(savedLevels);
      Object.entries(levels).forEach(([skill, level]) => {
        const input = document.querySelector(`#skills-grid input[data-skill="${skill}"]`);
        if (input) input.value = Math.min(level, 99);
      });
      updateTotalLevel();
    }
  }

  let autoRefreshInterval = null;
  let countdownSeconds = 299; // 5 minutes

  function startAutoRefreshCountdown() {
    // Clear any existing interval to avoid duplicates
    clearInterval(autoRefreshInterval);
    countdownSeconds = 299;
    updateCountdownDisplay();
    autoRefreshInterval = setInterval(() => {
      countdownSeconds--;
      updateCountdownDisplay();
      if (countdownSeconds <= 0) {
        if (document.getElementById("auto-refresh").checked) {
          refreshData();
        }
        countdownSeconds = 299; // restart countdown
      }
    }, 1000);
  }

  function resetAutoRefreshCountdown() {
    clearInterval(autoRefreshInterval);
    countdownSeconds = 299;
    updateCountdownDisplay();
    autoRefreshInterval = setInterval(() => {
      countdownSeconds--;
      updateCountdownDisplay();
      if (countdownSeconds <= 0) {
        refreshData();
        countdownSeconds = 299;
      }
    }, 1000);
  }


  function updateCountdownDisplay() {
    const countdown = document.getElementById("refresh-countdown");
    const minutes = Math.floor(countdownSeconds / 60);
    const seconds = countdownSeconds % 60;
    countdown.textContent = `(${minutes}:${seconds.toString().padStart(2, "0")})`;
  }

  // Load saved auto-refresh setting
  const savedAutoRefresh = localStorage.getItem("osrsAutoRefresh");
  if (savedAutoRefresh !== null) {
    document.getElementById("auto-refresh").checked = savedAutoRefresh === "true";
  }

  // Start timer if auto-refresh was enabled
  if (document.getElementById("auto-refresh").checked) {
    document.getElementById("refresh-countdown").style.display = "inline";
    startAutoRefreshCountdown();
  }

  // Respond to checkbox changes
  document.getElementById("auto-refresh").addEventListener("change", (event) => {
    const countdown = document.getElementById("refresh-countdown");
    const isChecked = event.target.checked;
    localStorage.setItem("osrsAutoRefresh", isChecked);
    if (isChecked) {
      countdown.style.display = "inline";
      startAutoRefreshCountdown();
    } else {
      clearInterval(autoRefreshInterval);
      countdown.style.display = "none";
    }
  });

  async function refreshData() {
    const needsUpdate = await shouldFetchData();
    // Force fetch if internal data hasn't been loaded yet
    const isDataLoaded = itemsById && Object.keys(itemsById).length > 0;
    if (needsUpdate || !isDataLoaded) {
      console.log('Fetching updated data...');
      await fetchData();
      displayResults();
    } else {
      console.log('No update needed. Skipping fetch.');
    }
    loadLastFetched(); // Always show time info
  }

  // async function refreshData() {
  //   await fetchData();
  //   displayResults();
  //   loadLastFetched();
  // }

  function getUserSkillLevels() {
    const levels = {};
    const inputs = document.querySelectorAll("#skills-grid input");
    inputs.forEach(input => {
      levels[input.dataset.skill] = parseInt(input.value) || 1;
    });
    return levels;
  }

  loadRecipes()
  refreshData();
  createSkillInputs();
  loadSkillLevels();

  // Load saved max cost
  const savedMaxCost = localStorage.getItem("osrsMaxCost");
  if (savedMaxCost !== null) {
    document.getElementById("max-cost").value = savedMaxCost;
  }

  // Restore saved RSN input
  const savedRSN = localStorage.getItem("osrsRSN");
  if (savedRSN !== null) {
    document.getElementById("rsn").value = savedRSN;
  }

  // Restore saved filter checkbox state
  const savedFilterBySkills = localStorage.getItem("osrsFilterBySkills");
  if (savedFilterBySkills !== null) {
    document.getElementById("filter-by-skills").checked = savedFilterBySkills === "true";
  }

  document.getElementById("refresh-button").addEventListener("click", () => {
    refreshData();
    if (document.getElementById("auto-refresh").checked) {
      resetAutoRefreshCountdown();
    }
  });
  document.getElementById("skills-button").addEventListener("click", toggleSkills);
  document.getElementById("hiscore-button").addEventListener("click", fetchHiscores);
  document.getElementById("rsn").addEventListener("input", (event) => {
    localStorage.setItem("osrsRSN", event.target.value);
  });
  document.getElementById("rsn").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      fetchHiscores();
    }
  });
  document.getElementById("filter-by-skills").addEventListener("change", (event) => {
    localStorage.setItem("osrsFilterBySkills", event.target.checked);
    displayResults();
  });
  document.getElementById("close-skills-button").addEventListener("click", toggleSkills);
  document.getElementById("max-cost").addEventListener("input", () => {
    const value = document.getElementById("max-cost").value;
    localStorage.setItem("osrsMaxCost", value);
    displayResults();
  });
  document.getElementById("custom-recipe-button").addEventListener("click", addCustomRecipe);

});
