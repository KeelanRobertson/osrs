document.addEventListener("DOMContentLoaded", () => {
  // 'data/' for git version
  // 'https://raw.githubusercontent.com/KeelanRobertson/osrs/main/data/' for local version
  const baseCacheUrl = 'https://raw.githubusercontent.com/KeelanRobertson/osrs/main/data/';
  const mappingUrl = baseCacheUrl + 'mapping.json';
  const cacheUrls = ['latest.json', '5m.json', '10m.json', '30m.json', '1h.json', '6h.json', '24h.json'].map(name => baseCacheUrl + name);

  let itemsById = {};
  let itemsByName = {};
  let recipes = [];
  let mapping = [];
  let priceData = [];  

  function formatFetchedTimes() {
    document.querySelectorAll('#last-fetched-time, #last-checked-time').forEach(el => {
      const raw = el.dataset.raw;
      if (!raw) return;

      const date = new Date(raw);
      if (isNaN(date.getTime())) return;

      el.textContent = date.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
    });
  }

  async function loadLastFetched() {
    try {
      const res = await fetch(baseCacheUrl + 'last_fetched.json');
      if (!res.ok) throw new Error('Failed to load last fetched time');
      const data = await res.json();
      const lastFetchedDate = new Date(data.lastFetched);
      const now = new Date();

      const fetchedEl = document.getElementById('last-fetched-time');
      const checkedEl = document.getElementById('last-checked-time');

      if (fetchedEl) {
        fetchedEl.dataset.raw = lastFetchedDate.toISOString();
      }

      if (checkedEl) {
        checkedEl.dataset.raw = now.toISOString();
      }

      formatFetchedTimes();

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

  let relatedItemsMap = {};

  function buildRelatedItemsMap() {
    relatedItemsMap = {};

    recipes.forEach(recipe => {
      const output = recipe.output?.item.toLowerCase();
      const inputs = recipe.inputs?.map(i => i.item.toLowerCase()) || [];
      const name = recipe.name.toLowerCase();

      const allStrings = [output, name, ...inputs];
      allStrings.forEach(str => {
        if (!relatedItemsMap[str]) relatedItemsMap[str] = new Set();
      });

      // Relate input to output
      inputs.forEach(input => {
        relatedItemsMap[input]?.add(output);
      });

      // Relate output to each input
      relatedItemsMap[output]?.add(...inputs);

      // Relate name to all
      relatedItemsMap[name]?.add(output);
      inputs.forEach(input => relatedItemsMap[name]?.add(input));
    });
  }

  async function loadRecipes() {
    const res = await fetch(baseCacheUrl + 'recipes.json');
    recipes = await res.json();
    buildRelatedItemsMap();
  }

  async function fetchData() {
    mapping = await fetch(mappingUrl).then(res => res.json());
    priceData = await Promise.all(cacheUrls.map(url => fetch(url).then(res => res.json())));

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

  function calculateProfit(recipe, useAlchValue = false) {
    const useOptimal = document.getElementById("use-optimal-price")?.checked ?? false;
    const outputItem = itemsByName[recipe.output.item.toLowerCase()];
    const baseOutputValue = useAlchValue
    ? outputItem?.highalch || 0
    : (useOptimal
        ? outputItem?.maxHigh || 0
        : outputItem?.currentHigh || 0);
    const grossOutputPricePerItem = baseOutputValue;
    const netOutputPricePerItem = useAlchValue
      ? grossOutputPricePerItem
      : applyGEtax(grossOutputPricePerItem);

    const grossOutputPrice = grossOutputPricePerItem * recipe.output.quantity;
    const netOutputPrice = netOutputPricePerItem * recipe.output.quantity;


    const inputDetails = recipe.inputs.map(input => {
      const inputItem = itemsByName[input.item.toLowerCase()];
      const price = useOptimal
        ? (inputItem?.minLow || 0) // current buy
        : (inputItem?.currentLow || 0);    // avg buy
      return {
        ...input,
        price,
        current: inputItem?.currentLow || 0,
        total: price * input.quantity
      };
    });

    let inputCost = inputDetails.reduce((sum, i) => sum + i.total, 0);
    
    // Add Nature rune cost if using High Alch
    if (useAlchValue) {
      const natureRune = itemsByName["nature rune"];
      const runeCost = natureRune?.minLow || 0;
      const runeCurrent = natureRune?.currentLow || 0;

      inputCost += runeCost;
      inputDetails.push({
        item: "Nature rune",
        displayName: "Nature rune (Alch)",
        quantity: 1,
        price: runeCost,
        current: runeCurrent,
        total: runeCost
      });
    }
    
    const profitPerItem = netOutputPricePerItem - (inputCost / recipe.output.quantity);
    const totalProfit = netOutputPrice - inputCost;
    const tax = grossOutputPrice - netOutputPrice;

    return {
      recipeName: recipe.name,
      outputItem: recipe.output.item,
      outputQuantity: recipe.output.quantity,
      outputPrice: outputItem?.maxHigh || 0,
      currentOutputPrice: outputItem?.currentHigh || 0,
      grossOutputPrice,
      netOutputPrice,
      grossOutputPricePerItem,
      netOutputPricePerItem,
      inputDetails,
      inputCost,
      profit: profitPerItem,
      totalProfit,
      tax
    };
  }

  let currentSortColumn = "profit"; // default sort
  let currentSortDirection = "desc"; // "asc" or "desc"
  
  // Utility functions
  function formatGp(value) {
    return `<span class="${value >= 0 ? 'positive' : 'negative'}">${Number(value).toLocaleString()}</span>`;
  }

  function getUserEquipment() {
    return new Set(
      Object.entries({
        herbloreCape: document.getElementById("equip-herbloreCape")?.checked,
        amuletOfChemistry: document.getElementById("equip-amuletOfChemistry")?.checked
      })
      .filter(([_, enabled]) => enabled)
      .map(([id]) => id)
    );
  }

  // 1. Expanded recipes
  function getExpandedRecipes() {
    const expanded = new Set();
    document.querySelectorAll(".recipe-details:not(.hidden)").forEach(detail => {
      const name = detail.closest(".recipe-row")?.querySelector(".recipe-cell.name")?.textContent;
      if (name) expanded.add(name);
    });
    return expanded;
  }

  // Group recipes by output
  const groupedRecipes = recipes.reduce((acc, recipe) => {
    if (!acc[recipe.output]) acc[recipe.output] = [];
    acc[recipe.output].push(recipe);
    return acc;
  }, {});

  Object.entries(groupedRecipes).forEach(([outputName, recipeGroup]) => {
    const results = recipeGroup.map(recipe => calculateProfit(recipe));
    const row = createRecipeRow(recipeGroup, results, toggleAllButton, container, expandedRecipes);
    container.appendChild(row);
  });

  // 2. Filtering
  function filterRecipes(recipes, userSkills, filterEnabled, maxCost, searchText, xpSkillFilter, useAlchValue = false) {
    let hiddenBySkills = 0;
    let hiddenByCost = 0;
    const lowerSearch = searchText.trim().toLowerCase();
    const relatedSet = relatedItemsMap[lowerSearch] || new Set();
    const userGear = getUserEquipment();

    // Step 2: Filter by direct match or related items
    const searchFiltered = recipes.filter(recipe => {
      const result = calculateProfit(recipe, useAlchValue);
      const inputs = result.inputDetails.map(i => i.item.toLowerCase());
      const output = result.outputItem.toLowerCase();
      const name = recipe.name.toLowerCase();

      return (
        name.includes(lowerSearch) ||
        output.includes(lowerSearch) ||
        inputs.some(i => i.includes(lowerSearch)) ||
        // relatedSet.has(name) ||
        relatedSet.has(output) ||
        inputs.some(i => relatedSet.has(i))
      );
    });
    
    // Filter by skill levels, specific skill, cost, gear
    const filtered = searchFiltered.filter(recipe => {
      const result = calculateProfit(recipe, useAlchValue);
      const totalInputCost = result.inputDetails.reduce((sum, i) => sum + i.total, 0);

      const skillPass = !filterEnabled || !recipe.requiredSkills || Object.entries(recipe.requiredSkills).every(
        ([skill, level]) => userSkills[skill.toLowerCase()] >= level
      );
      const costPass = totalInputCost <= maxCost;

      const xpPass = !xpSkillFilter || (
        (
          recipe.experienceGained &&
          Object.keys(recipe.experienceGained).some(skill => skill.toLowerCase() === xpSkillFilter)
        ) ||
        (
          recipe.requiredSkills &&
          Object.keys(recipe.requiredSkills).some(skill => skill.toLowerCase() === xpSkillFilter)
        )
      );

      const gearPass = !recipe.requiredEquipment || recipe.requiredEquipment.every(
        equip => userGear.has(equip)
      );

      if (!skillPass) hiddenBySkills++;
      if (skillPass && !costPass) hiddenByCost++;

      return skillPass && costPass && xpPass && gearPass;
    });

    return { filtered, hiddenBySkills, hiddenByCost };
  }

  // 3. Sorting
  function sortRecipes(recipes, sortColumn, sortDirection) {
    const grouped = recipes.reduce((acc, recipe) => {
      const outputName = recipe.output.item;
      if (!acc[outputName]) acc[outputName] = [];
      acc[outputName].push(recipe);
      return acc;
    }, {});

    const groupedArray = Object.entries(grouped).map(([outputName, recipeGroup]) => {
      const useAlchProfit = document.getElementById("use-alch-profit")?.checked ?? false;
      const results = recipeGroup.map(r => calculateProfit(r, useAlchProfit));
      const combined = recipeGroup.map((recipe, i) => ({ recipe, result: results[i] }));

      const best = combined.reduce((a, b) => {
        return b.result.profit > a.result.profit ? b : a;
      });

      return {
        outputName,
        recipes: recipeGroup,
        results,
        bestResult: best.result,
        bestRecipe: best.recipe
      };
    });

    groupedArray.sort((a, b) => {
      let valA, valB;
      const getTotalCost = r => {
        const totalCost = r.inputDetails.reduce((sum, i) => sum + i.total, 0);
        return totalCost / r.outputQuantity;
      };
      switch (sortColumn) {
        case "name":
          valA = a.outputName.toLowerCase();
          valB = b.outputName.toLowerCase();
          break;
        case "profit":
          valA = a.bestResult.profit;
          valB = b.bestResult.profit;
          break;
        case "cost":
          valA = getTotalCost(a.bestResult);
          valB = getTotalCost(b.bestResult);
          break;
        case "sell":
          valA = a.bestResult.outputPrice;
          valB = b.bestResult.outputPrice;
          break;
        case "now":
          valA = a.bestResult.currentOutputPrice;
          valB = b.bestResult.currentOutputPrice;
          break;
        case "limit":
          valA = (mapping.find(item => item.name === a.bestResult.outputItem)?.limit ?? 0);
          valB = (mapping.find(item => item.name === b.bestResult.outputItem)?.limit ?? 0);
          break;
        case "volume":
          const idA = mapping.find(item => item.name === a.bestResult.outputItem)?.id;
          const idB = mapping.find(item => item.name === b.bestResult.outputItem)?.id;
          const volA = priceData[6]?.data?.[idA];
          const volB = priceData[6]?.data?.[idB];
          valA = volA ? volA.highPriceVolume + volA.lowPriceVolume : 0;
          valB = volB ? volB.highPriceVolume + volB.lowPriceVolume : 0;
          break;
        case "high-alch":
          valA = (mapping.find(item => item.name === a.bestResult.outputItem)?.highalch ?? 0);
          valB = (mapping.find(item => item.name === b.bestResult.outputItem)?.highalch ?? 0);
          break;
        case "skill-reqs":
          const skillSum = skills =>
            Object.values(skills || {}).reduce((sum, lvl) => sum + lvl, 0);
          valA = skillSum(a.bestRecipe.requiredSkills);
          valB = skillSum(b.bestRecipe.requiredSkills);
          break;
        case "xp-gained":
          const xpSum = xpObj => 
            Object.values(xpObj || {}).reduce((sum, xp) => sum + xp, 0);
          valA = xpSum(a.bestRecipe.experienceGained);
          valB = xpSum(b.bestRecipe.experienceGained);
          break;
        default:
          return 0;
      }

      if (valA < valB) return sortDirection === "asc" ? -1 : 1;
      if (valA > valB) return sortDirection === "asc" ? 1 : -1;
      return 0;
    });
    return groupedArray;
  }

  // 4. Header
  function createHeaderRow(container) {
    const headerRow = document.createElement("div");
    headerRow.className = "recipe-header";
    headerRow.innerHTML = `
      <div class="header-cell icon"></div>
      <div class="header-cell name" data-column="name">Name <span class="sort-indicator"></span></div>
      <div class="header-cell profit" data-column="profit">Profit <span class="sort-indicator"></span></div>
      <div class="header-cell cost" data-column="cost">Cost <span class="sort-indicator"></span></div>
      <div class="header-cell sell" data-column="sell">Sell <span class="sort-indicator"></span></div>
      <div class="header-cell now" data-column="now">Current <span class="sort-indicator"></span></div>
      <div class="header-cell limit" data-column="limit">Limit <span class="sort-indicator"></span></div>
      <div class="header-cell volume" data-column="volume">Volume <span class="sort-indicator"></span></div>
      <div class="header-cell high-alch" data-column="high-alch">Alch <span class="sort-indicator"></span></div>
      <div class="header-cell xp-gained" data-column="xp-gained">XP <span class="sort-indicator"></span></div>
      <div class="header-cell skill-reqs" data-column="skill-reqs">Skills <span class="sort-indicator"></div>
      <div class="header-cell price-link"></div>
    `;
    container.appendChild(headerRow);

    headerRow.querySelectorAll(".header-cell[data-column]").forEach(cell => {
      cell.style.cursor = "pointer";
      cell.addEventListener("click", () => {
        const column = cell.getAttribute("data-column");
        if (currentSortColumn === column) {
          currentSortDirection = currentSortDirection === "asc" ? "desc" : "asc";
        } else {
          currentSortColumn = column;
          currentSortDirection = column === "name" ? "asc" : "desc";
        }
        displayResults();
      });
    });

    updateSortIndicators(headerRow);
    return headerRow;
  }

  function updateSortIndicators(headerRow) {
    headerRow.querySelectorAll(".header-cell[data-column]").forEach(cell => {
      const indicator = cell.querySelector(".sort-indicator");
      const column = cell.getAttribute("data-column");
      indicator.textContent = column === currentSortColumn
        ? (currentSortDirection === "asc" ? "▲" : "▼")
        : "";
    });
  }

  // 5. Expand/Collapse All
  function createToggleAllButton(container) {
    const toggleAllButton = document.createElement("button");
    toggleAllButton.id = "toggle-all";
    toggleAllButton.textContent = "Expand All";
    toggleAllButton.style.marginBottom = "10px";
    container.appendChild(toggleAllButton);

    toggleAllButton.addEventListener("click", () => {
      const details = container.querySelectorAll(".recipe-details");
      const anyOpen = Array.from(details).some(d => !d.classList.contains("hidden"));

      details.forEach(d => d.classList.toggle("hidden", anyOpen));
      toggleAllButton.textContent = anyOpen ? "Expand All" : "Collapse All";
    });

    return toggleAllButton;
  }

  function updateToggleAllButtonLabel(container, button) {
    const details = container.querySelectorAll(".recipe-details:not(.hidden)");
    const anyExpanded = Array.from(details).some(d => !d.classList.contains("hidden"));
    button.textContent = anyExpanded ? "Collapse All" : "Expand All";
  }

  // 6. Create each recipe row
  function createRecipeRow(recipeGroup, resultGroup, toggleAllButton, container, expandedRecipes) {
    const outputName = recipeGroup[0].output.item;
    const combinedSorted = recipeGroup.map((recipe, i) => ({
      recipe,
      result: resultGroup[i]
    })).sort((a, b) => b.result.profit - a.result.profit);
    const bestResult = combinedSorted[0].result;
    const mappingData = mapping.find(item => item.name === bestResult.outputItem);
    const itemId = mappingData?.id;
    const volumeData = priceData[6]?.data?.[itemId];
    const imageUrl = mappingData
      ? `https://oldschool.runescape.wiki/images/thumb/${encodeURIComponent(mappingData.icon.replace(/ /g, "_"))}/40px-${encodeURIComponent(mappingData.icon.replace(/ /g, "_"))}`
      : "";
    const buyLimit = mappingData?.limit ?? "N/A";
    const highAlch = mappingData?.highalch ?? 0;
    const dailyVolume = volumeData
      ? (volumeData.highPriceVolume + volumeData.lowPriceVolume)
      : "Unknown";
    const experienceGained = recipeGroup[0]?.experienceGained || {};
    const skillExp = Object.entries(experienceGained).map(([skill, xp]) => {
      const capitalizedSkill = skill.charAt(0).toUpperCase() + skill.slice(1);
      const skillIconUrl = `https://oldschool.runescape.wiki/images/${capitalizedSkill}_icon.png`;
      return `
        <div class="skill-icon-row">
          <img src="${skillIconUrl}" alt="${capitalizedSkill}" class="skill-icon">
          <span class="skill-level">${xp.toLocaleString()}</span>
        </div>
      `;
    }).join("");
    const requiredSkills = recipeGroup[0]?.requiredSkills || {};
    const userSkills = getUserSkillLevels();
    const skillIcons = Object.entries(requiredSkills).map(([skill, level]) => {
      const capitalizedSkill = skill.charAt(0).toUpperCase() + skill.slice(1);
      const skillIconUrl = `https://oldschool.runescape.wiki/images/${capitalizedSkill}_icon.png`;
      const userLevel = userSkills[skill.toLowerCase()] || 0;
      const missingClass = userLevel < level ? "missing-skill" : "";
      return `
        <div class="skill-icon-row ${missingClass}">
          <img src="${skillIconUrl}" alt="${capitalizedSkill}" class="skill-icon">
          <span class="skill-level">${level.toLocaleString()}</span>
        </div>
      `;
    }).join("");
    const priceHistoryUrl = itemId ? `https://prices.runescape.wiki/osrs/item/${itemId}` : "#";

    const row = document.createElement("div");
    row.className = "recipe-row";
    row.innerHTML = `
      <div class="recipe-summary">
        <div class="recipe-cell icon-cell">
          <img src="${imageUrl}" alt="${outputName}" class="item-icon">
        </div>
        <span class="recipe-cell name">${outputName}</span>
        <span class="recipe-cell profit">${formatGp(bestResult.profit).toLocaleString()}</span>
        <span class="recipe-cell cost">${(bestResult.inputCost / bestResult.outputQuantity).toLocaleString()}</span>
        <span class="recipe-cell price-sell">${bestResult.grossOutputPricePerItem.toLocaleString()}</span>
        <span class="recipe-cell price-now">${bestResult.currentOutputPrice.toLocaleString()}</span>
        <span class="recipe-cell limit">${buyLimit.toLocaleString()}</span>
        <span class="recipe-cell volume">${dailyVolume.toLocaleString()}</span>
        <span class="recipe-cell high-alch">${highAlch.toLocaleString()}</span>
        <span class="recipe-cell xp-gained">${skillExp || "—"}</span>
        <span class="recipe-cell skill-reqs">${skillIcons || "—"}</span>
        <span class="recipe-cell price-link">
          <a href="${priceHistoryUrl}" target="_blank" rel="noopener noreferrer">
            <img src="https://prices.runescape.wiki/osrs/static/media/Grand_Exchange_logo.dd4bba0bac42379d54d8.png" alt="Price History" class="price-icon">
          </a>
        </span>
      </div>
      <div class="recipe-details hidden">
        ${combinedSorted.map(({ result }, index) => {
          return `
          <div class="recipe-variant">
            <p>
              <strong>Recipe ${index + 1}:</strong>
              Crafts ${result.outputQuantity} × ${result.outputItem},
              Total Input Cost: ${formatGp(result.inputCost)},
              Profit per item: ${formatGp(result.profit)}
            </p>
            <div class="input-items">
              <div class="input-item-header">
                <span></span>
                <span class="input-name">Item</span>
                <span class="input-qty">Qty</span>
                <span class="input-price">Buy / Sell</span>
                <span class="input-current">Current</span>
                <span class="input-total">Total</span>
                <span class="input-limit">Limit</span>
                <span class="input-volume">Volume</span>
              </div>
              ${result.inputDetails.map(input => {
                const inputMap = mapping.find(item => item.name === input.item);
                const inputLimit = inputMap?.limit ?? "N/A"
                const inputId = inputMap?.id;
                const inputVolume = priceData[6]?.data?.[inputId];
                const inputDailyVolume = inputVolume ? (inputVolume.highPriceVolume + inputVolume.lowPriceVolume).toLocaleString() : "Unknown";
                const inputImage = inputMap ? `https://oldschool.runescape.wiki/images/thumb/${encodeURIComponent(inputMap.icon.replace(/ /g, "_"))}/40px-${encodeURIComponent(inputMap.icon.replace(/ /g, "_"))}` : "";
                const inputPriceHistoryUrl = inputId 
                  ? `https://prices.runescape.wiki/osrs/item/${inputId}` 
                  : "#";

                return `
                  <div class="input-item-row alt-row">
                    <img src="${inputImage}" alt="${input.item}" class="item-icon">
                    <span class="input-name">${input.displayName || input.item}</span>
                    <span class="input-qty">${input.quantity.toLocaleString()}</span>
                    <span class="input-price">${input.price.toLocaleString()}</span>
                    <span class="input-current">${input.current.toLocaleString()}</span>
                    <span class="input-total">${input.total.toLocaleString()}</span>
                    <span class="input-limit">${inputLimit.toLocaleString()}</span>
                    <span class="input-volume">${inputDailyVolume.toLocaleString()}</span>
                    <span class="input-link">
                      <a href="${inputPriceHistoryUrl}" target="_blank" rel="noopener noreferrer">
                        <img src="https://prices.runescape.wiki/osrs/static/media/Grand_Exchange_logo.dd4bba0bac42379d54d8.png" 
                            alt="Price History" class="price-icon">
                      </a>
                    </span>
                  </div>
                `;
              }).join("")}
            </div>
            <!-- Total cost row -->
            <div class="recipe-total-row">
              <strong>Total Input Cost:</strong> ${formatGp(result.inputCost)}
            </div>

            <!-- Output row -->
            <div class="recipe-output-row alt-row">
              <img src="${imageUrl}" alt="${result.outputItem}" class="item-icon">
              <span class="output-name">${result.outputItem}</span>
              <span class="output-qty">${result.outputQuantity}</span>
              <span class="output-sell">${result.grossOutputPricePerItem.toLocaleString()}</span>
              <span class="output-current">${result.currentOutputPrice.toLocaleString()}</span>
              <span class="output-total">${(result.outputQuantity * result.grossOutputPricePerItem).toLocaleString()}</span>
              <span class="output-limit">${buyLimit.toLocaleString()}</span>
              <span class="output-volume">${dailyVolume.toLocaleString()}</span>
              <span class="output-cell price-link">
                <a href="${priceHistoryUrl}" target="_blank" rel="noopener noreferrer">
                  <img src="https://prices.runescape.wiki/osrs/static/media/Grand_Exchange_logo.dd4bba0bac42379d54d8.png" alt="Price History" class="price-icon">
                </a>
              </span>
            </div>
            <!-- Tax row -->
            <div class="recipe-total-row">
              <strong>Tax:</strong> ${formatGp(-(result.tax))}
            </div>

            <!-- Profit row -->
            <div class="recipe-total-row">
              <strong>Profit:</strong> ${formatGp(result.totalProfit)}
            </div>

          </div>
          `;
        }).join("")}
      </div>
    `;

    const summary = row.querySelector(".recipe-summary");
    const details = row.querySelector(".recipe-details");

    if (expandedRecipes.has(outputName)) {
      details.classList.remove("hidden");
    }

    summary.addEventListener("click", () => {
      details.classList.toggle("hidden");
      updateToggleAllButtonLabel(container, toggleAllButton);
    });

    return row;
  }

  // 7. Main function
  function displayResults() {
    const expandedRecipes = getExpandedRecipes();

    const container = document.getElementById("results-container");
    container.innerHTML = "";
  
    const searchText = document.getElementById("search-box").value.toLowerCase();
    const userSkills = getUserSkillLevels();
    const filterEnabled = document.getElementById("filter-by-skills").checked;
    const maxCost = parseInt(document.getElementById("max-cost").value) || Infinity;
    const useAlchValue = document.getElementById("use-alch-profit")?.checked || false;
    const xpSkillFilterValue = window.xpSkillFilter || "";

    const { filtered: filteredRecipes, hiddenBySkills, hiddenByCost } = filterRecipes(
      recipes, userSkills, filterEnabled, maxCost, searchText, xpSkillFilterValue, useAlchValue
    );

    const toggleAllButton = createToggleAllButton(container);
    createHeaderRow(container);

    updateToggleAllButtonLabel(container, toggleAllButton);

    const groupedSorted = sortRecipes(filteredRecipes, currentSortColumn, currentSortDirection);

    // --- PAGINATION LOGIC ---
    const totalResults = groupedSorted.length;
    const totalPages = Math.ceil(totalResults / resultsPerPage);
    // Save globally for buttons
    window.totalPages = totalPages;

    if (currentPage > totalPages) {
      currentPage = totalPages || 1; // fallback if no results
    }

    const start = (currentPage - 1) * resultsPerPage;
    const end = start + resultsPerPage;

    const pagedResults = groupedSorted.slice(start, end);

    pagedResults.forEach(group => {
      const row = createRecipeRow(group.recipes, group.results, toggleAllButton, container, expandedRecipes);
      container.appendChild(row);
    });



    document.getElementById("skill-filter-count").textContent = hiddenBySkills;
    document.getElementById("cost-filter-count").textContent = hiddenByCost;

    document.getElementById("page-info").textContent =
      totalPages > 0 ? `Page ${currentPage} of ${totalPages}` : "No results";

    document.getElementById("prev-page").disabled = currentPage <= 1;
    document.getElementById("next-page").disabled = currentPage >= totalPages;
  }

  // Results per page
  let currentPage = 1;
  let resultsPerPage = parseInt(localStorage.getItem("resultsPerPage")) || 50;
  document.getElementById("results-per-page").value = resultsPerPage;

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

  const skills = {
    "Agility": "https://oldschool.runescape.wiki/images/Agility_icon.png",
    "Attack": "https://oldschool.runescape.wiki/images/Attack_icon.png",
    "Construction": "https://oldschool.runescape.wiki/images/Construction_icon.png",
    "Cooking": "https://oldschool.runescape.wiki/images/Cooking_icon.png",
    "Crafting": "https://oldschool.runescape.wiki/images/Crafting_icon.png",
    "Defence": "https://oldschool.runescape.wiki/images/Defence_icon.png",
    "Farming": "https://oldschool.runescape.wiki/images/Farming_icon.png",
    "Firemaking": "https://oldschool.runescape.wiki/images/Firemaking_icon.png",
    "Fishing": "https://oldschool.runescape.wiki/images/Fishing_icon.png",
    "Fletching": "https://oldschool.runescape.wiki/images/Fletching_icon.png",
    "Herblore": "https://oldschool.runescape.wiki/images/Herblore_icon.png",
    "Hitpoints": "https://oldschool.runescape.wiki/images/Hitpoints_icon.png",
    "Hunter": "https://oldschool.runescape.wiki/images/Hunter_icon.png",
    "Magic": "https://oldschool.runescape.wiki/images/Magic_icon.png",
    "Mining": "https://oldschool.runescape.wiki/images/Mining_icon.png",
    "Prayer": "https://oldschool.runescape.wiki/images/Prayer_icon.png",
    "Ranged": "https://oldschool.runescape.wiki/images/Ranged_icon.png",
    "Runecraft": "https://oldschool.runescape.wiki/images/Runecraft_icon.png",
    "Slayer": "https://oldschool.runescape.wiki/images/Slayer_icon.png",
    "Smithing": "https://oldschool.runescape.wiki/images/Smithing_icon.png",
    "Strength": "https://oldschool.runescape.wiki/images/Strength_icon.png",
    "Thieving": "https://oldschool.runescape.wiki/images/Thieving_icon.png",
    "Woodcutting": "https://oldschool.runescape.wiki/images/Woodcutting_icon.png"
  };

  window.xpSkillFilter = "";  // Default to show all

  function renderSkillDropdown(skills) {
    const container = document.getElementById("xp-skill-filter-container");
    container.innerHTML = ""; // clear existing

    const selectWrapper = document.createElement("div");
    selectWrapper.className = "custom-select";
    const allIconUrl = "https://oldschool.runescape.wiki/images/Stats_icon.png";

    const selected = document.createElement("div");
    selected.className = "select-selected";
    selected.innerHTML = `<img src="${allIconUrl}" alt="All Skills icon">${"All Skills"}`;
    selectWrapper.appendChild(selected);


    const optionsDiv = document.createElement("div");
    optionsDiv.className = "select-items";

    // Add "All Skills" option first
    const allOption = document.createElement("div");
    allOption.innerHTML = `<img src="${allIconUrl}" alt="All Skills icon">${"All Skills"}`;
    allOption.dataset.value = "";
    allOption.addEventListener("click", () => {
      selected.innerHTML = `<img src="${allIconUrl}" alt="All Skills icon">All Skills`;
      optionsDiv.style.display = "none";
      window.xpSkillFilter = "";
      displayResults();
    });
    optionsDiv.appendChild(allOption);

    Object.entries(skills).forEach(([name, icon]) => {
      const option = document.createElement("div");
      option.innerHTML = `<img src="${icon}" alt="${name} icon">${name}`;
      option.dataset.value = name.toLowerCase();
      option.addEventListener("click", () => {
        selected.innerHTML = `<img src="${icon}" alt="${name} icon">${name}`;
        optionsDiv.style.display = "none";
        window.xpSkillFilter = name.toLowerCase(); // Or use `skillKey` if needed
        displayResults();
      });
      optionsDiv.appendChild(option);
    });

    selectWrapper.appendChild(optionsDiv);
    container.appendChild(selectWrapper);

    selected.addEventListener("click", () => {
      optionsDiv.style.display = optionsDiv.style.display === "block" ? "none" : "block";
    });

    // Close dropdown if clicked outside
    document.addEventListener("click", (e) => {
      if (!selectWrapper.contains(e.target)) {
        optionsDiv.style.display = "none";
      }
    });
  }

  function toggleSkills() {
    const modal = document.getElementById("filters-modal");
    const style = window.getComputedStyle(modal);
    if (style.display === "none") {
      modal.style.display = "block";
    } else {
      modal.style.display = "none";
    }
  }

  function updateTotalLevel() {
    const inputs = document.querySelectorAll("#skills-grid input");
    let total = 0;
    const levels = {};
    inputs.forEach(input => {
      let val = Math.min(Math.max(parseInt(input.value) || 1, 1), 99);
      input.value = val;
      total += val;
      levels[input.dataset.skill.toLowerCase()] = val;
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
        const input = document.querySelector(`#skills-grid input[data-skill="${apiName}"]`);
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

  function getUserSkillLevels() {
    const levels = {};
    const inputs = document.querySelectorAll("#skills-grid input");
    inputs.forEach(input => {
      levels[input.dataset.skill] = parseInt(input.value) || 1;
    });
    return levels;
  }

  (async function init() {
    await loadRecipes();
    await loadTaxExemptItems();
    await refreshData();
    loadSkillLevels();
    renderSkillDropdown(skills);

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

    const savedUseAlchProfit = localStorage.getItem("osrsUseAlchProfit");
    if (savedUseAlchProfit !== null) {
      document.getElementById("use-alch-profit").checked = savedUseAlchProfit === "true";
    }

    // Set up event listeners
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
    document.querySelectorAll('#skills-grid input[type="number"]').forEach(input => {
      input.addEventListener('input', updateTotalLevel);
    });
    document.getElementById("refresh-button").addEventListener("click", () => {
      refreshData();
      if (document.getElementById("auto-refresh").checked) {
        resetAutoRefreshCountdown();
      }
    });
    document.getElementById("filters-button").addEventListener("click", toggleSkills);
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
    document.getElementById("close-filters-button").addEventListener("click", toggleSkills);
    document.getElementById("max-cost").addEventListener("input", () => {
      const value = document.getElementById("max-cost").value;
      localStorage.setItem("osrsMaxCost", value);
      displayResults();
    });
    document.getElementById("equip-herbloreCape").addEventListener("change", displayResults);
    document.getElementById("search-box").addEventListener("input", () => {
      displayResults();
    });
    document.getElementById("results-per-page").addEventListener("change", (e) => {
      resultsPerPage = parseInt(e.target.value);
      localStorage.setItem("resultsPerPage", resultsPerPage);
      currentPage = 1; // reset to first page
      displayResults();
    });
    document.getElementById("prev-page").addEventListener("click", () => {
      if (currentPage > 1) {
        currentPage--;
        displayResults();
      }
    });
    document.getElementById("next-page").addEventListener("click", () => {
      if (currentPage < window.totalPages) {
        currentPage++;
        displayResults();
      }
    });
    document.getElementById("use-alch-profit").addEventListener("change", (event) => {
      localStorage.setItem("osrsUseAlchProfit", event.target.checked);
      displayResults();
    });
    document.getElementById("use-optimal-price").addEventListener("change", displayResults);
    document.addEventListener("change", (e) => {
      if (e.target.id === "xp-skill-filter") {
        const selected = e.target.value;
        const skill = skills.find(s => s.name.toLowerCase() === selected);
        const iconEl = document.getElementById("xp-skill-icon");

        if (skill) {
          iconEl.src = skill.icon;
          iconEl.style.display = "inline-block";
        } else {
          iconEl.style.display = "none";
        }

        displayResults(); // trigger your filter logic
      }
    });
    document.getElementById("custom-recipe-button").addEventListener("click", addCustomRecipe);
  })();
});