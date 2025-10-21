(() => {
  const BLE_PROFILES = {
    hm10: {
      service: 0xffe0,
      tx: 0xffe1,
      rx: 0xffe1,
    },
    nus: {
      service: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
      tx: "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
      rx: "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
    },
    sps: {
      service: "49535343-fe7d-4ae5-8fa9-9fafd205e455",
      tx: "49535343-8841-43f4-a8d4-ecbeeebb68c3",
      rx: "49535343-1e4d-4bd9-ba61-23c647249616",
    },
  };

  const OPTIONAL_SERVICES = [
    BLE_PROFILES.hm10.service,
    BLE_PROFILES.nus.service,
    BLE_PROFILES.sps.service,
  ];

  const PID = {
    SPEED: "010D",
    MAF: "0110",
  };

  const UI = {
    connectBtn: document.getElementById("connectBtn"),
    disconnectBtn: document.getElementById("disconnectBtn"),
    simulateBtn: document.getElementById("simulateBtn"),
    connectionState: document.getElementById("connectionState"),
    deviceName: document.getElementById("deviceName"),
    pollingState: document.getElementById("pollingState"),
    instantConsumption: document.getElementById("instantConsumption"),
    averageConsumption: document.getElementById("averageConsumption"),
    fuelFlow: document.getElementById("fuelFlow"),
    vehicleSpeed: document.getElementById("vehicleSpeed"),
    tripDistance: document.getElementById("tripDistance"),
    tripFuel: document.getElementById("tripFuel"),
    sessionDuration: document.getElementById("sessionDuration"),
    resetTripBtn: document.getElementById("resetTripBtn"),
    logWindow: document.getElementById("logWindow"),
    clearLogBtn: document.getElementById("clearLogBtn"),
    rawToggle: document.getElementById("rawToggle"),
    installPrompt: document.getElementById("installPrompt"),
    openSettings: document.getElementById("openSettings"),
    settingsDialog: document.getElementById("settingsDialog"),
    profileSelect: document.getElementById("profileSelect"),
    pollingInterval: document.getElementById("pollingInterval"),
    afrInput: document.getElementById("afrInput"),
    densityInput: document.getElementById("densityInput"),
    saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  };

  const defaultSettings = {
    profile: "auto",
    interval: 1000,
    afr: 14.5,
    density: 0.832, // kg/l pro naftu
  };

  const state = {
    connected: false,
    device: null,
    server: null,
    txCharacteristic: null,
    rxCharacteristic: null,
    pollingTimer: null,
    lastSpeed: 0,
    lastFuelFlow: 0,
    instantConsumption: null,
    samples: [],
    sessionStart: null,
    lastSampleTime: null,
    totalFuelLiters: 0,
    totalDistanceKm: 0,
    logLines: [],
    settings: loadSettings(),
    commandQueue: [],
    currentCommand: null,
    buffer: "",
    isSimulating: false,
    simulationTimer: null,
  };

  let deferredPrompt = null;

  function loadSettings() {
    try {
      const payload = localStorage.getItem("elm-reader-settings");
      if (!payload) return { ...defaultSettings };
      return { ...defaultSettings, ...JSON.parse(payload) };
    } catch (error) {
      console.warn("Nelze načíst nastavení", error);
      return { ...defaultSettings };
    }
  }

  function persistSettings() {
    localStorage.setItem("elm-reader-settings", JSON.stringify(state.settings));
  }

  function updateSettingsUI() {
    UI.profileSelect.value = state.settings.profile;
    UI.pollingInterval.value = state.settings.interval;
    UI.afrInput.value = state.settings.afr;
    UI.densityInput.value = state.settings.density;
  }

  function setConnectionStatus(status, deviceName = "—") {
    UI.connectionState.textContent = status;
    UI.deviceName.textContent = deviceName;
  }

  function setPollingStatus(active) {
    UI.pollingState.textContent = active ? "běží" : "neaktivní";
    UI.pollingState.className = active ? "text-success" : "";
  }

  function clamp(number, min, max) {
    return Math.min(Math.max(number, min), max);
  }

  function formatNumber(value, decimals = 2) {
    if (Number.isNaN(value) || value === null || value === undefined) {
      return "—";
    }
    return value.toFixed(decimals);
  }

  function formatDuration(ms) {
    if (!ms) return "0:00";
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }

  function log(message, { raw = false, level = "info" } = {}) {
    if (raw && !UI.rawToggle.checked) {
      return;
    }
    const timestamp = new Date().toLocaleTimeString();
    const line = `[${timestamp}] ${message}`;
    state.logLines.push({ line, level });
    if (state.logLines.length > 500) {
      state.logLines.shift();
    }
    UI.logWindow.textContent = state.logLines
      .map((entry) => entry.line)
      .join("\n");
    UI.logWindow.scrollTop = UI.logWindow.scrollHeight;
  }

  function resetSession() {
    state.samples = [];
    state.lastSampleTime = null;
    state.totalFuelLiters = 0;
    state.totalDistanceKm = 0;
    state.instantConsumption = null;
    state.lastFuelFlow = 0;
    state.lastSpeed = 0;
    state.sessionStart = state.connected ? Date.now() : null;
    renderStats();
    log("Statistiky vynulovány.");
  }

  function renderStats() {
    UI.instantConsumption.textContent = formatNumber(state.instantConsumption, 2);
    const average =
      state.totalDistanceKm > 0
        ? (state.totalFuelLiters / state.totalDistanceKm) * 100
        : null;
    UI.averageConsumption.textContent = formatNumber(average, 2);
    UI.fuelFlow.textContent = formatNumber(state.lastFuelFlow, 2);
    UI.vehicleSpeed.textContent = formatNumber(state.lastSpeed, 0);
    UI.tripDistance.textContent = `${formatNumber(state.totalDistanceKm, 2)} km`;
    UI.tripFuel.textContent = `${formatNumber(state.totalFuelLiters, 2)} l`;
    UI.sessionDuration.textContent = formatDuration(
      state.sessionStart ? Date.now() - state.sessionStart : 0,
    );
  }

  function appendSample(speed, fuelFlow, instantConsumption) {
    const now = Date.now();
    if (!state.sessionStart) {
      state.sessionStart = now;
    }
    if (state.lastSampleTime) {
      const deltaHours = (now - state.lastSampleTime) / 3600000;
      const avgSpeed = (state.lastSpeed + speed) / 2;
      const avgFuelFlow = (state.lastFuelFlow + fuelFlow) / 2;
      state.totalDistanceKm += avgSpeed * deltaHours;
      state.totalFuelLiters += avgFuelFlow * deltaHours;
    }
    state.lastSampleTime = now;
    state.lastSpeed = speed;
    state.lastFuelFlow = fuelFlow;
    state.instantConsumption = instantConsumption;
    state.samples.push({
      timestamp: now,
      speed,
      fuelFlow,
      instantConsumption,
    });
    if (state.samples.length > 600) {
      state.samples.shift();
    }
    renderStats();
  }

  function parseOBDResponse(response) {
    const lines = response
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith("AT"));
    return lines;
  }

  function parseSpeedPid(line) {
    const tokens = line.split(" ");
    if (tokens.length < 3) return null;
    if (tokens[0] !== "41" || tokens[1] !== "0D") return null;
    const speed = parseInt(tokens[2], 16);
    return Number.isFinite(speed) ? speed : null;
  }

  function parseMafPid(line) {
    const tokens = line.split(" ");
    if (tokens.length < 4) return null;
    if (tokens[0] !== "41" || tokens[1] !== "10") return null;
    const high = parseInt(tokens[2], 16);
    const low = parseInt(tokens[3], 16);
    if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
    return ((high << 8) + low) / 100; // g/s
  }

  function calculateFuelFlow(maf) {
    const afr = clamp(state.settings.afr, 10, 20);
    const density = clamp(state.settings.density, 0.6, 1.0);
    const gramsPerSecondFuel = maf / afr;
    const litersPerSecond = gramsPerSecondFuel / (density * 1000);
    return litersPerSecond * 3600; // l/h
  }

  function calculateInstantConsumption(fuelFlow, speed) {
    if (!speed || speed <= 1) {
      return null;
    }
    return (fuelFlow / speed) * 100;
  }

  function simulateData() {
    const speed = Math.max(
      0,
      state.lastSpeed + (Math.random() * 14 - 7),
    );
    const maf = 25 + Math.random() * 20; // g/s
    const fuelFlow = calculateFuelFlow(maf);
    const instant = calculateInstantConsumption(fuelFlow, speed);
    appendSample(speed, fuelFlow, instant);
    log(`Simulace: rychlost ${formatNumber(speed, 0)} km/h, spotřeba ${formatNumber(instant, 1)} l/100km`);
  }

  function toggleSimulation() {
    state.isSimulating = !state.isSimulating;
    if (state.isSimulating) {
      UI.simulateBtn.textContent = "Zastavit simulaci";
      stopPolling();
      disconnectDevice();
      resetSession();
      state.simulationTimer = window.setInterval(
        simulateData,
        state.settings.interval,
      );
      state.connected = false;
      setConnectionStatus("Simulace", "Virtuální data");
      setPollingStatus(true);
    } else {
      UI.simulateBtn.textContent = "Vyzkoušet simulaci";
      if (state.simulationTimer) {
        window.clearInterval(state.simulationTimer);
      }
      setConnectionStatus("Nepřipojeno");
      setPollingStatus(false);
    }
  }

  function clearLog() {
    state.logLines = [];
    UI.logWindow.textContent = "";
  }

  async function connectDevice() {
    if (!navigator.bluetooth) {
      alert("Web Bluetooth není v tomto prohlížeči podporován.");
      return;
    }
    try {
      stopSimulation();
      UI.connectBtn.disabled = true;
      log("Vyvolávám dialog pro připojení…");
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: OPTIONAL_SERVICES,
      });
      state.device = device;
      state.device.addEventListener("gattserverdisconnected", handleDisconnect);
      setConnectionStatus("Připojování…", device.name || "Neznámé zařízení");
      log(`Vybrané zařízení: ${device.name || "bez názvu"}`);

      state.server = await device.gatt.connect();
      log("GATT připojeno, hledám servis.");

      const profile = await resolveProfile();
      if (!profile) {
        throw new Error("Nepodařilo se najít odpovídající BLE servis.");
      }

      state.txCharacteristic = await getCharacteristic(
        profile.service,
        profile.tx,
      );
      state.rxCharacteristic = profile.rx
        ? await getCharacteristic(profile.service, profile.rx)
        : state.txCharacteristic;

      await state.rxCharacteristic.startNotifications();
      state.rxCharacteristic.addEventListener(
        "characteristicvaluechanged",
        handleIncomingData,
      );

      state.connected = true;
      state.sessionStart = Date.now();
      UI.disconnectBtn.disabled = false;
      log("Spojení navázáno, inicializuji ELM327.");
      setConnectionStatus("Inicializace…", state.device.name || "ELM327");

      await initialiseElm();
      resetSession();
      setConnectionStatus("Připojeno", state.device.name || "ELM327");
      log("ELM327 připraven, startuji dotazování.");
      startPolling();
    } catch (error) {
      console.error(error);
      log(`Chyba: ${error.message}`, { level: "error" });
      alert(error.message);
      await disconnectDevice();
    } finally {
      UI.connectBtn.disabled = false;
    }
  }

  async function resolveProfile() {
    if (!state.server) return null;
    const order =
      state.settings.profile === "auto"
        ? ["hm10", "nus", "sps"]
        : [state.settings.profile];

    for (const key of order) {
      const profile = BLE_PROFILES[key];
      if (!profile) continue;
      try {
        const service = await state.server.getPrimaryService(profile.service);
        return { ...profile, service };
      } catch (error) {
        log(`Servis ${key} nenalezen (${error.message})`);
      }
    }
    return null;
  }

  async function getCharacteristic(service, uuid) {
    if (typeof uuid === "number") {
      return service.getCharacteristic(uuid);
    }
    return service.getCharacteristic(uuid);
  }

  async function initialiseElm() {
    const commands = [
      "ATZ", // reset
      "ATE0", // echo off
      "ATL0", // linefeeds off
      "ATS0", // spaces off
      "ATH0", // headers off
      "ATSP0", // automatic protocol
      "0100", // supported PIDs
    ];
    for (const command of commands) {
      const response = await sendCommand(command);
      log(`${command} → ${response}`);
    }
  }

  function stopPolling() {
    if (state.pollingTimer) {
      window.clearInterval(state.pollingTimer);
      state.pollingTimer = null;
      setPollingStatus(false);
    }
  }

  function startPolling() {
    stopPolling();
    if (!state.connected) return;
    const poll = async () => {
      try {
        const [speedRaw, mafRaw] = await Promise.all([
          sendCommand(PID.SPEED, { silent: true }),
          sendCommand(PID.MAF, { silent: true }),
        ]);
        const speedLines = parseOBDResponse(speedRaw);
        const mafLines = parseOBDResponse(mafRaw);
        const speed = speedLines
          .map(parseSpeedPid)
          .find((value) => value !== null);
        const maf = mafLines.map(parseMafPid).find((value) => value !== null);
        if (speed !== null) {
          log(`Rychlost: ${speed} km/h`);
        }
        if (maf !== null) {
          log(`MAF: ${maf.toFixed(2)} g/s`);
        }
        if (maf !== null) {
          const fuelFlow = calculateFuelFlow(maf);
          const instant = calculateInstantConsumption(fuelFlow, speed || 0);
          appendSample(speed || 0, fuelFlow, instant);
        }
      } catch (error) {
        log(`Chyba při čtení PID: ${error.message}`, { level: "error" });
      }
    };
    poll();
    state.pollingTimer = window.setInterval(poll, state.settings.interval);
    setPollingStatus(true);
  }

  function stopSimulation() {
    if (state.isSimulating) {
      toggleSimulation();
    }
  }

  async function disconnectDevice() {
    stopPolling();
    state.connected = false;
    if (state.simulationTimer) {
      window.clearInterval(state.simulationTimer);
      state.simulationTimer = null;
    }
    if (state.rxCharacteristic) {
      try {
        state.rxCharacteristic.removeEventListener(
          "characteristicvaluechanged",
          handleIncomingData,
        );
        await state.rxCharacteristic.stopNotifications();
      } catch (error) {
        console.warn("Chyba při odpojování notifikací", error);
      }
    }
    if (state.device?.gatt?.connected) {
      state.device.gatt.disconnect();
    }
    state.server = null;
    state.txCharacteristic = null;
    state.rxCharacteristic = null;
    state.commandQueue.forEach((entry) =>
      entry.reject?.(new Error("Připojení bylo ukončeno.")),
    );
    state.commandQueue = [];
    state.currentCommand = null;
    state.buffer = "";
    UI.disconnectBtn.disabled = true;
    setConnectionStatus("Nepřipojeno");
    setPollingStatus(false);
  }

  function handleDisconnect() {
    log("Zařízení se odpojilo.");
    disconnectDevice();
  }

  async function sendCommand(command, { silent = false } = {}) {
    if (!state.txCharacteristic) {
      throw new Error("TX charakteristika není dostupná.");
    }
    return new Promise((resolve, reject) => {
      state.commandQueue.push({
        command,
        resolve,
        reject,
        silent,
      });
      processQueue();
    });
  }

  function processQueue() {
    if (state.currentCommand || !state.commandQueue.length) {
      return;
    }
    const entry = state.commandQueue[0];
    state.currentCommand = entry;
    writeCommand(entry).catch((error) => {
      state.commandQueue.shift();
      state.currentCommand = null;
      entry.reject(error);
      processQueue();
    });
  }

  async function writeCommand(entry) {
    const command = entry.command.trim().toUpperCase();
    const fullCommand = `${command}\r`;
    const encoder = new TextEncoder();
    const data = encoder.encode(fullCommand);
    try {
      if (state.txCharacteristic.writeValueWithoutResponse) {
        await state.txCharacteristic.writeValueWithoutResponse(data);
      } else {
        await state.txCharacteristic.writeValue(data);
      }
      if (!entry.silent) {
        log(`Odesláno: ${command}`);
      }
    } catch (error) {
      log(`Chyba zápisu: ${error.message}`, { level: "error" });
      throw error;
    }
  }

  function handleIncomingData(event) {
    const decoder = new TextDecoder();
    const chunk = decoder.decode(event.target.value);
    state.buffer += chunk;
    if (UI.rawToggle.checked) {
      log(`⇠ ${chunk.trim()}`, { raw: true });
    }
    let promptIndex;
    // ELM327 ukončuje ">" promptem
    while ((promptIndex = state.buffer.indexOf(">")) !== -1) {
      const message = state.buffer.slice(0, promptIndex);
      state.buffer = state.buffer.slice(promptIndex + 1);
      const current = state.commandQueue.shift();
      state.currentCommand = null;
      processQueue();
      if (!current) {
        log(`Nečekaný blok: ${message}`);
        continue;
      }
      const cleaned = message.replace(/\u0000/g, "").trim();
      if (!current.silent) {
        log(`Odpověď na ${current.command}: ${cleaned}`);
      }
      current.resolve(cleaned);
    }
  }

  function handleBeforeInstallPrompt(event) {
    event.preventDefault();
    deferredPrompt = event;
    UI.installPrompt.hidden = false;
  }

  async function triggerPwaInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    log(`PWA instalace: ${outcome}`);
    UI.installPrompt.hidden = true;
    deferredPrompt = null;
  }

  function setupEvents() {
    UI.connectBtn.addEventListener("click", connectDevice);
    UI.disconnectBtn.addEventListener("click", disconnectDevice);
    UI.simulateBtn.addEventListener("click", toggleSimulation);
    UI.resetTripBtn.addEventListener("click", resetSession);
    UI.clearLogBtn.addEventListener("click", clearLog);
    UI.openSettings.addEventListener("click", () => {
      updateSettingsUI();
      UI.settingsDialog.showModal();
    });
    UI.saveSettingsBtn.addEventListener("click", () => {
      state.settings = {
        profile: UI.profileSelect.value,
        interval: Number(UI.pollingInterval.value) || defaultSettings.interval,
        afr: Number(UI.afrInput.value) || defaultSettings.afr,
        density: Number(UI.densityInput.value) || defaultSettings.density,
      };
      persistSettings();
      UI.settingsDialog.close();
      log("Nastavení uloženo.");
      if (state.connected && state.pollingTimer) {
        startPolling();
      }
    });
    UI.installPrompt.addEventListener("click", triggerPwaInstall);
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", () => {
      log("Aplikace byla nainstalována.");
      UI.installPrompt.hidden = true;
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && state.isSimulating) {
        stopSimulation();
      }
    });
  }

  function enforceHttps() {
    if (
      window.location.protocol === "http:" &&
      window.location.hostname !== "localhost"
    ) {
      window.location.replace(
        `https://${window.location.hostname}${window.location.pathname}`,
      );
    }
  }

  function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("sw.js")
        .then(() => log("Service worker registrován."))
        .catch((error) =>
          log(`Service worker selhal: ${error.message}`, {
            level: "error",
          }),
        );
    }
  }

  function init() {
    enforceHttps();
    setupEvents();
    updateSettingsUI();
    renderStats();
    log("Aplikace připravena. Pro čtení dat klikni na „Připojit OBD-II“.");
    registerServiceWorker();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
