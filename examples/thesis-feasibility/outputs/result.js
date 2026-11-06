window.MAS_RESULT = {
  "title": "mmWave radar Airbnb check-in feasibility — run 2",
  "run": 2,
  "updated": "2026-11-05T13:23:45Z",
  "markdown": "## Executive Summary\nExpanding the timeline to 9 months makes hardware bring-up, perturbation testing, and prototype integration fully feasible within the £1000 budget and 3-person team. However, zero-shot open-set gait identification of unseen guests remains scientifically unproven, and non-consensual biometric processing retains severe GDPR Article 9 risks.\n\n## Requirement & Feasibility Matrix\n| Requirement | 9-Month Feasibility | Evidence |\n|---|---|---|\n| R1: Technical Feasibility | Mixed (Closed-Set Proven; Open-Set High Risk) | TI IWR6843 achieves 95%+ on known subjects; open-set remains unsolved |\n| R2: Team & Budget (9 Mo, £1000) | Fully Feasible | 9 months provides sufficient runway for extensive empirical experiments |\n| R3: Privacy & Airbnb Rules | Compliant for Occupancy; Risky for Biometrics | Complies with Airbnb camera ban; violates GDPR Art. 9 for unconsented biometrics |\n| R4: Breakdown & Sources | Complete | Clear matrix and cited literature cards in sources/ |\n\n## What the Checkers Caught\n- **Open-Set Barrier**: 9 months allows deep experimentation, but cannot overcome fundamental sparsity limits for zero-shot new guest identification.\n- **GDPR Article 9**: Capturing biometric gait data without explicit guest consent remains legally prohibitive.\n\n## Recommendations\n1. Pivot to privacy-preserving occupancy & party detection\n2. Multi-modal check-in pairing radar with digital keys\n3. Academic bounds analysis of open-set mmWave gait recognition",
  "sources": [
    {
      "id": "ti-iwr6843-gait",
      "title": "Towards a Low-Cost Solution for Gait Analysis Using Millimeter Wave Sensor and Machine Learning",
      "url": "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8038167/",
      "evidence": "B",
      "foundBy": "literature-finder"
    },
    {
      "id": "mmgait-open-set",
      "title": "Open-Set Gait Recognition from Sparse mmWave Radar Point Clouds",
      "url": "https://arxiv.org/abs/2503.07435",
      "evidence": "B",
      "foundBy": "literature-finder"
    },
    {
      "id": "airbnb-indoor-camera-policy",
      "title": "Airbnb Policy on Security Cameras and Recording Devices",
      "url": "https://news.airbnb.com/airbnb-updates-policy-on-indoor-security-cameras/",
      "evidence": "A",
      "foundBy": "privacy-scout"
    },
    {
      "id": "gdpr-article-9-biometrics",
      "title": "GDPR Article 9 - Processing of Special Categories of Personal Data",
      "url": "https://gdpr-info.eu/art-9-gdpr/",
      "evidence": "A",
      "foundBy": "privacy-scout"
    }
  ],
  "flags": [
    {
      "by": "feasibility-critic",
      "text": "Open-set gait recognition for unseen guests remains an unsolved problem, and GDPR Article 9 prohibits unconsented biometric processing regardless of timeline."
    }
  ],
  "work": [
    {
      "by": "feasibility-critic",
      "summary": "- **Team Composition (3 Persons)**:\n- Hardware engineer: Interface TI mmWave radar (DCA1000EVM data capture or IWR UART/SPI streaming) with host MCU/SBC.\n- AI engineer: Signal pre-processing (FFT, CFAR, micro-Doppler extraction) and neural network inference.\n- Software engineer: Local database/dashboard, notification alerts, and Airbnb host integration."
    },
    {
      "by": "literature-finder",
      "summary": "- **Radar Hardware**: Texas Instruments 60 GHz–64 GHz FMCW sensors (notably TI IWR6843 / IWR6843ISK-ODS and IWR1443).\n- **Data Modalities**:\n- **Micro-Doppler Spectrograms**: High-resolution Doppler velocity shifts induced by torso and limb swinging.\n- **3D Sparse Point Clouds**: Spatial coordinates ($X, Y, Z$), Doppler velocity, and signal reflection intensity (SNR)."
    },
    {
      "by": "privacy-scout",
      "summary": "- **Total Ban on Indoor Cameras**: According to [airbnb-indoor-camera-policy](../../sources/airbnb-indoor-camera-policy.md), Airbnb strictly bans all indoor security cameras and…\n- **Allowed Indoor Sensors**: Noise decibel monitors (e.g., Minut, NoiseAware) and basic presence sensors are permitted in indoor common areas provided they do not record audio/…\n- **Platform Positioning of Radar**: mmWave radar does NOT capture optical imagery or audio, legally distancing it from camera bans. However, stealthy installation or ambiguous …\n- **Biometric Identification Threshold**: Under [gdpr-article-9-biometrics](../../sources/gdpr-article-9-biometrics.md), capturing physical behavioural characteristics (gait sig…"
    }
  ]
};
