# Privacy, Policy, and Legal Assessment for Airbnb Radar Deployment

## 1. Airbnb Platform Policies
- **Total Ban on Indoor Cameras**: According to [airbnb-indoor-camera-policy](../../sources/airbnb-indoor-camera-policy.md), Airbnb strictly bans all indoor security cameras and video recording devices globally, even in common areas and hallways, regardless of disclosure.
- **Allowed Indoor Sensors**: Noise decibel monitors (e.g., Minut, NoiseAware) and basic presence sensors are permitted in indoor common areas provided they do not record audio/video and are explicitly disclosed in the listing prior to booking.
- **Platform Positioning of Radar**: mmWave radar does NOT capture optical imagery or audio, legally distancing it from camera bans. However, stealthy installation or ambiguous descriptions can trigger guest complaints and host listing removal.

## 2. Regulatory & Biometric Compliance (GDPR / UK GDPR)
- **Biometric Identification Threshold**: Under [gdpr-article-9-biometrics](../../sources/gdpr-article-9-biometrics.md), capturing physical behavioural characteristics (gait signatures) to uniquely identify an individual constitutes biometric data processing.
- **Explicit Consent Mandate**: Processing biometric data for identification legally requires explicit, opt-in consent from every individual guest before data collection occurs.
- **Data Minimization & Local Processing**: To remain privacy-preserving, radar signal processing must occur strictly on edge (DSP/local microcontroller), and raw point clouds/spectrograms should never be uploaded or stored long-term.

## 3. Recommended Privacy-Preserving Architecture
- **Pivot from Biometric Identification to Presence/Occupancy**: Instead of attempting to identify guest identities, use the radar to measure headcount, entryway presence, and party detection.
- **Guest Notification**: Clear disclosure in the booking listing: "Disclosed mmWave occupancy sensor installed in entryway — records no images or audio."

## 3-Line Summary
1. mmWave radar circumvents Airbnb's strict indoor camera ban because it captures zero optical imagery or audio.
2. Uniquely identifying guests via gait creates severe legal risks under GDPR Article 9 without explicit prior consent.
3. Repositioning radar for non-biometric occupancy and party detection provides full policy compliance and high guest acceptance.
