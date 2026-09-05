import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { detectLanguage } from './detector';

// EN baseline
import enCommon from './locales/en/common.json';
import enNav from './locales/en/nav.json';
import enExplore from './locales/en/explore.json';
import enBotDetail from './locales/en/botDetail.json';
import enUpload from './locales/en/upload.json';
import enLibrary from './locales/en/library.json';
import enSettings from './locales/en/settings.json';
import enEnergy from './locales/en/energy.json';
import enEarn from './locales/en/earn.json';
import enSplash from './locales/en/splash.json';
import enCustomizeScene from './locales/en/customizeScene.json';
import enTagGenerator from './locales/en/tagGenerator.json';

// ZH
import zhCommon from './locales/zh/common.json';
import zhNav from './locales/zh/nav.json';
import zhExplore from './locales/zh/explore.json';
import zhBotDetail from './locales/zh/botDetail.json';
import zhUpload from './locales/zh/upload.json';
import zhLibrary from './locales/zh/library.json';
import zhSettings from './locales/zh/settings.json';
import zhEnergy from './locales/zh/energy.json';
import zhEarn from './locales/zh/earn.json';
import zhSplash from './locales/zh/splash.json';
import zhCustomizeScene from './locales/zh/customizeScene.json';
import zhTagGenerator from './locales/zh/tagGenerator.json';

// JA
import jaCommon from './locales/ja/common.json';
import jaNav from './locales/ja/nav.json';
import jaExplore from './locales/ja/explore.json';
import jaBotDetail from './locales/ja/botDetail.json';
import jaUpload from './locales/ja/upload.json';
import jaLibrary from './locales/ja/library.json';
import jaSettings from './locales/ja/settings.json';
import jaEnergy from './locales/ja/energy.json';
import jaEarn from './locales/ja/earn.json';
import jaSplash from './locales/ja/splash.json';
import jaCustomizeScene from './locales/ja/customizeScene.json';
import jaTagGenerator from './locales/ja/tagGenerator.json';

// KO
import koCommon from './locales/ko/common.json';
import koNav from './locales/ko/nav.json';
import koExplore from './locales/ko/explore.json';
import koBotDetail from './locales/ko/botDetail.json';
import koUpload from './locales/ko/upload.json';
import koLibrary from './locales/ko/library.json';
import koSettings from './locales/ko/settings.json';
import koEnergy from './locales/ko/energy.json';
import koEarn from './locales/ko/earn.json';
import koSplash from './locales/ko/splash.json';
import koCustomizeScene from './locales/ko/customizeScene.json';
import koTagGenerator from './locales/ko/tagGenerator.json';

// AR
import arCommon from './locales/ar/common.json';
import arNav from './locales/ar/nav.json';
import arExplore from './locales/ar/explore.json';
import arBotDetail from './locales/ar/botDetail.json';
import arUpload from './locales/ar/upload.json';
import arLibrary from './locales/ar/library.json';
import arSettings from './locales/ar/settings.json';
import arEnergy from './locales/ar/energy.json';
import arEarn from './locales/ar/earn.json';
import arSplash from './locales/ar/splash.json';
import arCustomizeScene from './locales/ar/customizeScene.json';
import arTagGenerator from './locales/ar/tagGenerator.json';

// DE
import deCommon from './locales/de/common.json';
import deNav from './locales/de/nav.json';
import deExplore from './locales/de/explore.json';
import deBotDetail from './locales/de/botDetail.json';
import deUpload from './locales/de/upload.json';
import deLibrary from './locales/de/library.json';
import deSettings from './locales/de/settings.json';
import deEnergy from './locales/de/energy.json';
import deEarn from './locales/de/earn.json';
import deSplash from './locales/de/splash.json';
import deCustomizeScene from './locales/de/customizeScene.json';
import deTagGenerator from './locales/de/tagGenerator.json';

// ES
import esCommon from './locales/es/common.json';
import esNav from './locales/es/nav.json';
import esExplore from './locales/es/explore.json';
import esBotDetail from './locales/es/botDetail.json';
import esUpload from './locales/es/upload.json';
import esLibrary from './locales/es/library.json';
import esSettings from './locales/es/settings.json';
import esEnergy from './locales/es/energy.json';
import esEarn from './locales/es/earn.json';
import esSplash from './locales/es/splash.json';
import esCustomizeScene from './locales/es/customizeScene.json';
import esTagGenerator from './locales/es/tagGenerator.json';

// FR
import frCommon from './locales/fr/common.json';
import frNav from './locales/fr/nav.json';
import frExplore from './locales/fr/explore.json';
import frBotDetail from './locales/fr/botDetail.json';
import frUpload from './locales/fr/upload.json';
import frLibrary from './locales/fr/library.json';
import frSettings from './locales/fr/settings.json';
import frEnergy from './locales/fr/energy.json';
import frEarn from './locales/fr/earn.json';
import frSplash from './locales/fr/splash.json';
import frCustomizeScene from './locales/fr/customizeScene.json';
import frTagGenerator from './locales/fr/tagGenerator.json';

// IT
import itCommon from './locales/it/common.json';
import itNav from './locales/it/nav.json';
import itExplore from './locales/it/explore.json';
import itBotDetail from './locales/it/botDetail.json';
import itUpload from './locales/it/upload.json';
import itLibrary from './locales/it/library.json';
import itSettings from './locales/it/settings.json';
import itEnergy from './locales/it/energy.json';
import itEarn from './locales/it/earn.json';
import itSplash from './locales/it/splash.json';
import itCustomizeScene from './locales/it/customizeScene.json';
import itTagGenerator from './locales/it/tagGenerator.json';

// NL
import nlCommon from './locales/nl/common.json';
import nlNav from './locales/nl/nav.json';
import nlExplore from './locales/nl/explore.json';
import nlBotDetail from './locales/nl/botDetail.json';
import nlUpload from './locales/nl/upload.json';
import nlLibrary from './locales/nl/library.json';
import nlSettings from './locales/nl/settings.json';
import nlEnergy from './locales/nl/energy.json';
import nlEarn from './locales/nl/earn.json';
import nlSplash from './locales/nl/splash.json';
import nlCustomizeScene from './locales/nl/customizeScene.json';
import nlTagGenerator from './locales/nl/tagGenerator.json';

// PT
import ptCommon from './locales/pt/common.json';
import ptNav from './locales/pt/nav.json';
import ptExplore from './locales/pt/explore.json';
import ptBotDetail from './locales/pt/botDetail.json';
import ptUpload from './locales/pt/upload.json';
import ptLibrary from './locales/pt/library.json';
import ptSettings from './locales/pt/settings.json';
import ptEnergy from './locales/pt/energy.json';
import ptEarn from './locales/pt/earn.json';
import ptSplash from './locales/pt/splash.json';
import ptCustomizeScene from './locales/pt/customizeScene.json';
import ptTagGenerator from './locales/pt/tagGenerator.json';

// RU
import ruCommon from './locales/ru/common.json';
import ruNav from './locales/ru/nav.json';
import ruExplore from './locales/ru/explore.json';
import ruBotDetail from './locales/ru/botDetail.json';
import ruUpload from './locales/ru/upload.json';
import ruLibrary from './locales/ru/library.json';
import ruSettings from './locales/ru/settings.json';
import ruEnergy from './locales/ru/energy.json';
import ruEarn from './locales/ru/earn.json';
import ruSplash from './locales/ru/splash.json';
import ruCustomizeScene from './locales/ru/customizeScene.json';
import ruTagGenerator from './locales/ru/tagGenerator.json';

const ns = ['common', 'nav', 'explore', 'botDetail', 'upload', 'library', 'settings', 'energy', 'earn', 'splash', 'customizeScene', 'tagGenerator'] as const;

i18n.use(initReactI18next).init({
  lng: detectLanguage(),
  fallbackLng: 'en',
  ns: [...ns],
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  resources: {
    en: { common: enCommon, nav: enNav, explore: enExplore, botDetail: enBotDetail, upload: enUpload, library: enLibrary, settings: enSettings, energy: enEnergy, earn: enEarn, splash: enSplash, customizeScene: enCustomizeScene, tagGenerator: enTagGenerator },
    zh: { common: zhCommon, nav: zhNav, explore: zhExplore, botDetail: zhBotDetail, upload: zhUpload, library: zhLibrary, settings: zhSettings, energy: zhEnergy, earn: zhEarn, splash: zhSplash, customizeScene: zhCustomizeScene, tagGenerator: zhTagGenerator },
    ja: { common: jaCommon, nav: jaNav, explore: jaExplore, botDetail: jaBotDetail, upload: jaUpload, library: jaLibrary, settings: jaSettings, energy: jaEnergy, earn: jaEarn, splash: jaSplash, customizeScene: jaCustomizeScene, tagGenerator: jaTagGenerator },
    ko: { common: koCommon, nav: koNav, explore: koExplore, botDetail: koBotDetail, upload: koUpload, library: koLibrary, settings: koSettings, energy: koEnergy, earn: koEarn, splash: koSplash, customizeScene: koCustomizeScene, tagGenerator: koTagGenerator },
    ar: { common: arCommon, nav: arNav, explore: arExplore, botDetail: arBotDetail, upload: arUpload, library: arLibrary, settings: arSettings, energy: arEnergy, earn: arEarn, splash: arSplash, customizeScene: arCustomizeScene, tagGenerator: arTagGenerator },
    de: { common: deCommon, nav: deNav, explore: deExplore, botDetail: deBotDetail, upload: deUpload, library: deLibrary, settings: deSettings, energy: deEnergy, earn: deEarn, splash: deSplash, customizeScene: deCustomizeScene, tagGenerator: deTagGenerator },
    es: { common: esCommon, nav: esNav, explore: esExplore, botDetail: esBotDetail, upload: esUpload, library: esLibrary, settings: esSettings, energy: esEnergy, earn: esEarn, splash: esSplash, customizeScene: esCustomizeScene, tagGenerator: esTagGenerator },
    fr: { common: frCommon, nav: frNav, explore: frExplore, botDetail: frBotDetail, upload: frUpload, library: frLibrary, settings: frSettings, energy: frEnergy, earn: frEarn, splash: frSplash, customizeScene: frCustomizeScene, tagGenerator: frTagGenerator },
    it: { common: itCommon, nav: itNav, explore: itExplore, botDetail: itBotDetail, upload: itUpload, library: itLibrary, settings: itSettings, energy: itEnergy, earn: itEarn, splash: itSplash, customizeScene: itCustomizeScene, tagGenerator: itTagGenerator },
    nl: { common: nlCommon, nav: nlNav, explore: nlExplore, botDetail: nlBotDetail, upload: nlUpload, library: nlLibrary, settings: nlSettings, energy: nlEnergy, earn: nlEarn, splash: nlSplash, customizeScene: nlCustomizeScene, tagGenerator: nlTagGenerator },
    pt: { common: ptCommon, nav: ptNav, explore: ptExplore, botDetail: ptBotDetail, upload: ptUpload, library: ptLibrary, settings: ptSettings, energy: ptEnergy, earn: ptEarn, splash: ptSplash, customizeScene: ptCustomizeScene, tagGenerator: ptTagGenerator },
    ru: { common: ruCommon, nav: ruNav, explore: ruExplore, botDetail: ruBotDetail, upload: ruUpload, library: ruLibrary, settings: ruSettings, energy: ruEnergy, earn: ruEarn, splash: ruSplash, customizeScene: ruCustomizeScene, tagGenerator: ruTagGenerator },
  },
});

export default i18n;
