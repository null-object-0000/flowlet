import { attention } from "micromark-core-commonmark";
import { markdownLineEnding, unicodePunctuation } from "micromark-util-character";
import { classifyCharacter } from "micromark-util-classify-character";
import { factorySpace } from "micromark-factory-space";
import { codes, constants, types } from "micromark-util-symbol";

/* eslint-disable @typescript-eslint/no-explicit-any */
// 閫愬瓧绉绘鑷笂娓?dsh-client-ui-primitives 鐨?lib/types/markdown/cjkFriendlyStrong.js 涓?// mathCompatibility.js锛堝紩鐢ㄤ慨璁?47f943859b锛岃鍙瘉瑙?THIRD_PARTY_NOTICES.md锛夈€?// 涓よ€呭鐢?micromark-extension-math 鐨?token 璇嶆眹锛岃皟鐢ㄦ柟蹇呴』鍦ㄥ悓涓€ parse 閲屽悓鏃舵敞鍐?math()銆?
const cjkCharacter = new RegExp(
  [
    "\\p{Script_Extensions=Han}",
    "\\p{Script_Extensions=Hiragana}",
    "\\p{Script_Extensions=Katakana}",
    "\\p{Script_Extensions=Hangul}",
    "\\p{Script_Extensions=Bopomofo}",
  ].join("|"),
  "u",
);

function isCjkCharacter(code: number | null): boolean {
  return code !== null && code >= 0 && cjkCharacter.test(String.fromCodePoint(code));
}

/** 璁╂槦鍙峰己寮鸿皟鍦?CJK 鏁ｆ枃鏃犵┖鏍肩画鎺掓椂涔熻兘鍦ㄦ爣鐐瑰悗闂悎銆?*/
function tokenizeCjkFriendlyAttention(this: any, effects: any, ok: any, nok: any) {
  const configuredAttentionMarkers = this.parser.constructs.attentionMarkers.null;
  if (configuredAttentionMarkers === undefined) {
    throw new Error("micromark CommonMark attention markers are unavailable");
  }
  const attentionMarkers = configuredAttentionMarkers;
  const previous = this.previous;
  const before = classifyCharacter(previous);
  let marker: number = codes.eof as unknown as number;
  return start;

  function start(code: number): any {
    if (code !== codes.asterisk) return nok(code);
    marker = code;
    effects.enter("attentionSequence");
    return inside(code);
  }

  function inside(code: number): any {
    if (code === marker) {
      effects.consume(code);
      return inside;
    }
    const token = effects.exit("attentionSequence");
    const after = classifyCharacter(code);
    const open = !after || (after === constants.characterGroupPunctuation && Boolean(before)) || attentionMarkers.includes(code);
    const commonMarkClose = !before || (before === constants.characterGroupPunctuation && Boolean(after)) || attentionMarkers.includes(previous);
    const cjkStrongClose = token.end.offset - token.start.offset >= 2 && unicodePunctuation(previous) && isCjkCharacter(code);
    const close = commonMarkClose || cjkStrongClose;
    token._open = open;
    token._close = close;
    return ok(code);
  }
}

const cjkFriendlyAttention = {
  name: "cjkFriendlyAttention",
  resolveAll: attention.resolveAll,
  tokenize: tokenizeCjkFriendlyAttention,
};

/** micromark 璇硶鎵╁睍锛歚**寮鸿皟**` 鍦ㄦ棤绌烘牸 CJK 缁帓锛堝墠涓€瀛楃涓烘爣鐐广€佸悗涓€瀛楃涓?CJK锛夋椂闂悎銆?*/
export function cjkFriendlyStrong(): any {
  return { text: { [codes.asterisk]: cjkFriendlyAttention } };
}

// ---- mathCompatibility ----

function previousBackslash(this: any, code: number) {
  if (code !== codes.backslash) return true;
  const tail = this.events.at(-1);
  if (tail === undefined) return false;
  return tail[1].type === types.characterEscape;
}

/** \(...\) 琛屽唴 TeX 鏁板銆?*/
function tokenizeBackslashMathText(this: any, effects: any, ok: any, nok: any) {
  return start;

  function start(code: number) {
    if (code !== codes.backslash) return nok(code);
    effects.enter("mathText");
    effects.enter("mathTextSequence");
    effects.consume(code);
    return open;
  }

  function open(code: number) {
    if (code !== codes.leftParenthesis) return nok(code);
    effects.consume(code);
    effects.exit("mathTextSequence");
    return between;
  }

  function between(code: number): any {
    if (code === codes.eof) return nok(code);
    if (code === codes.backslash) {
      return effects.attempt({ partial: true, tokenize: tokenizeClose }, close, afterCloseAttempt)(code);
    }
    if (markdownLineEnding(code)) {
      effects.enter(types.lineEnding);
      effects.consume(code);
      effects.exit(types.lineEnding);
      return between;
    }
    return dataStart(code);
  }

  function afterCloseAttempt(code: number): any {
    return effects.check({ partial: true, tokenize: tokenizeOpen }, nok, dataStart)(code);
  }

  function dataStart(code: number): any {
    effects.enter("mathTextData");
    effects.consume(code);
    return code === codes.backslash ? afterDataBackslash : data;
  }

  function afterDataBackslash(code: number): any {
    if (code === codes.backslash) {
      effects.consume(code);
      return data;
    }
    return data(code);
  }

  function data(code: number): any {
    if (code === codes.eof || code === codes.backslash || markdownLineEnding(code)) {
      effects.exit("mathTextData");
      return between(code);
    }
    effects.consume(code);
    return data;
  }

  function close(code: number) {
    effects.exit("mathText");
    return ok(code);
  }

  function tokenizeClose(closeEffects: any, closeOk: any, closeNok: any) {
    return slash;

    function slash(code: number) {
      if (code !== codes.backslash) return closeNok(code);
      closeEffects.enter("mathTextSequence");
      closeEffects.consume(code);
      return parenthesis;
    }

    function parenthesis(code: number) {
      if (code !== codes.rightParenthesis) return closeNok(code);
      closeEffects.consume(code);
      closeEffects.exit("mathTextSequence");
      return closeOk;
    }
  }

  function tokenizeOpen(openEffects: any, openOk: any, openNok: any) {
    return slash;

    function slash(code: number) {
      if (code !== codes.backslash) return openNok(code);
      openEffects.enter(types.chunkString);
      openEffects.consume(code);
      return parenthesis;
    }

    function parenthesis(code: number) {
      if (code !== codes.leftParenthesis) return openNok(code);
      openEffects.consume(code);
      openEffects.exit(types.chunkString);
      return openOk;
    }
  }
}

/** 鐢熸垚 `\[...\]`锛堝琛岋級涓庡悓琛?`$$...$$`锛堝崟琛岋級鏄剧ず鏁板鐨?flow 鏋勯€犮€?*/
function createMathFlow(marker: number, openMarker: number, closeMarker: number, multiline: boolean) {
  const tokenize: any = function (this: any, effects: any, ok: any, nok: any) {
    const self = this;
    let oddBackslashRun = false;
    const tail = self.events.at(-1);
    const initialSize = tail?.[1].type === types.linePrefix ? tail[2].sliceSerialize(tail[1], true).length : 0;
    return start;

    function start(code: number) {
      if (code !== marker) return nok(code);
      effects.enter("mathFlow");
      effects.enter("mathFlowFence");
      effects.enter("mathFlowFenceSequence");
      effects.consume(code);
      return open;
    }

    function open(code: number) {
      if (code !== openMarker) return nok(code);
      effects.consume(code);
      effects.exit("mathFlowFenceSequence");
      effects.exit("mathFlowFence");
      return marker === codes.dollarSign ? afterDollarOpen : content;
    }

    function afterDollarOpen(code: number) {
      return code === codes.dollarSign ? nok(code) : content(code);
    }

    function content(code: number) {
      if (code === codes.eof) return nok(code);
      if (code === marker && (marker !== codes.dollarSign || !oddBackslashRun)) {
        return effects.attempt({ partial: true, tokenize: tokenizeClosingFence }, closed, afterClosingFenceAttempt)(code);
      }
      if (markdownLineEnding(code)) {
        return multiline ? effects.attempt(nonLazyContinuation, afterContinuation, nok)(code) : nok(code);
      }
      return valueStart(code);
    }

    function afterClosingFenceAttempt(code: number): any {
      return marker === codes.backslash
        ? effects.check({ partial: true, tokenize: tokenizeOpeningFence }, nok, markerValueStart)(code)
        : markerValueStart(code);
    }

    function afterContinuation(code: number): any {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spacer: any = initialSize ? factorySpace(effects, content as any, types.linePrefix, initialSize + 1) : content;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (effects.attempt as any)({ partial: true, tokenize: tokenizeClosingFence }, closed as any, spacer)(code);
    }

    function valueStart(code: number): any {
      effects.enter("mathFlowValue");
      oddBackslashRun = code === codes.backslash;
      effects.consume(code);
      return value;
    }

    function markerValueStart(code: number): any {
      effects.enter("mathFlowValue");
      oddBackslashRun = false;
      effects.consume(code);
      return valueAfterMarker;
    }

    function valueAfterMarker(code: number): any {
      if (code === marker) {
        effects.consume(code);
        return value;
      }
      return value(code);
    }

    function value(code: number): any {
      if (code === codes.eof || code === marker || markdownLineEnding(code)) {
        effects.exit("mathFlowValue");
        return content(code);
      }
      if (code === codes.backslash) oddBackslashRun = !oddBackslashRun;
      else oddBackslashRun = false;
      effects.consume(code);
      return value;
    }

    function closed(code: number) {
      effects.exit("mathFlow");
      return ok(code);
    }

    function tokenizeClosingFence(closeEffects: any, closeOk: any, closeNok: any) {
      return sequenceStart;

      function sequenceStart(code: number) {
        if (code !== marker) return closeNok(code);
        closeEffects.enter("mathFlowFence");
        closeEffects.enter("mathFlowFenceSequence");
        closeEffects.consume(code);
        return sequenceEnd;
      }

      function sequenceEnd(code: number) {
        if (code !== closeMarker) return closeNok(code);
        closeEffects.consume(code);
        closeEffects.exit("mathFlowFenceSequence");
        closeEffects.exit("mathFlowFence");
        return closeOk;
      }
    }

    function tokenizeOpeningFence(openEffects: any, openOk: any, openNok: any) {
      return sequenceStart;

      function sequenceStart(code: number) {
        if (code !== marker) return openNok(code);
        openEffects.enter(types.chunkString);
        openEffects.consume(code);
        return sequenceEnd;
      }

      function sequenceEnd(code: number) {
        if (code !== openMarker) return openNok(code);
        openEffects.consume(code);
        openEffects.exit(types.chunkString);
        return openOk;
      }
    }
  };
  return {
    concrete: true,
    name: marker === codes.dollarSign ? "sameLineDollarMathFlow" : "backslashMathFlow",
    tokenize,
  };
}

function tokenizeNonLazyContinuation(this: any, effects: any, ok: any, nok: any) {
  const self = this;
  return start;

  function start(code: number) {
    if (code === codes.eof) return ok(code);
    if (!markdownLineEnding(code)) return nok(code);
    effects.enter(types.lineEnding);
    effects.consume(code);
    effects.exit(types.lineEnding);
    return lineStart;
  }

  function lineStart(code: number) {
    return self.parser.lazy[self.now().line] ? nok(code) : ok(code);
  }
}

const nonLazyContinuation = { partial: true, tokenize: tokenizeNonLazyContinuation };
const backslashMathText = { name: "backslashMathText", previous: previousBackslash, tokenize: tokenizeBackslashMathText };
const backslashMathFlow = createMathFlow(codes.backslash, codes.leftSquareBracket, codes.rightSquareBracket, true);
const sameLineDollarMathFlow = createMathFlow(codes.dollarSign, codes.dollarSign, codes.dollarSign, false);

/** TeX 鍙嶆枩鏉犲垎闅旂涓庡悓琛屽睍绀虹編鍏冨潡锛氬鐢?math() 鐨?token 璇嶆眹锛岄渶涓?math() 鍚?parse 娉ㄥ唽銆?*/
export function mathCompatibility(): any {
  return {
    flow: {
      [codes.backslash]: backslashMathFlow,
      [codes.dollarSign]: sameLineDollarMathFlow,
    },
    text: { [codes.backslash]: backslashMathText },
  };
}