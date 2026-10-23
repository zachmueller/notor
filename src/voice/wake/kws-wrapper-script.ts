/**
 * The keyword-spotter sidecar, run as `python3 -u -c <this script> …`.
 *
 * sherpa-onnx ships no binary that reads raw PCM from stdin, and its English
 * keyword files must be spelled in the model's BPE pieces, so this small
 * wrapper does both: it tokenizes the wake word (and its alternative
 * spellings) with sentencepiece, runs `sherpa_onnx.KeywordSpotter` over
 * 16-bit little-endian mono PCM read from stdin, and reports JSON lines:
 *
 *   {"type":"ready","version":"2.0.0","tokens":["▁HE Y ▁NOT OR", …]}
 *   {"type":"hit","keyword":"hey_notor","endSample":28672}
 *   {"type":"warning","message":"…"}
 *   {"type":"error","code":"module_missing"|"model_missing"|"keyword_invalid"|"failed","message":"…"}
 *
 * `endSample` counts samples read when the keyword was detected — the same
 * counter the plugin keeps for the frames it writes. The protocol uses a
 * private copy of stdout; library logging is redirected to stderr.
 *
 * Requirements: `pip install sherpa-onnx sentencepiece` (no numpy).
 */
export const KWS_WRAPPER_PY = String.raw`import argparse
import array
import glob
import json
import os
import re
import sys
import tempfile


# Keep a private copy of stdout for the JSON protocol and send everything else
# (native library logging, stray prints) to stderr.
_protocol = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr


def emit(**obj):
    _protocol.write(json.dumps(obj) + "\n")
    _protocol.flush()


try:
    import sentencepiece
    import sherpa_onnx
except Exception as e:  # noqa: BLE001
    emit(type="error", code="module_missing", message=str(e))
    sys.exit(3)

parser = argparse.ArgumentParser()
parser.add_argument("--model-dir", required=True)
parser.add_argument("--keyword", required=True)
parser.add_argument("--variant", action="append", default=[])
parser.add_argument("--threshold", type=float, default=0.25)
parser.add_argument("--score", type=float, default=1.0)
parser.add_argument("--num-threads", type=int, default=1)
parser.add_argument("--sample-rate", type=int, default=16000)
parser.add_argument("--precision", choices=["int8", "fp32"], default="int8")
args = parser.parse_args()


def pick(prefix):
    files = sorted(glob.glob(os.path.join(args.model_dir, prefix + "*.onnx")))
    int8 = [f for f in files if f.endswith(".int8.onnx")]
    fp32 = [f for f in files if not f.endswith(".int8.onnx")]
    chosen = (int8 or fp32) if args.precision == "int8" else (fp32 or int8)
    if not chosen:
        emit(type="error", code="model_missing", message=f"No {prefix}*.onnx in {args.model_dir}")
        sys.exit(4)
    return chosen[0]


tokens_path = os.path.join(args.model_dir, "tokens.txt")
bpe_path = os.path.join(args.model_dir, "bpe.model")
with open(tokens_path, encoding="utf-8") as f:
    vocab = {line.split()[0] for line in f if line.strip()}
sp = sentencepiece.SentencePieceProcessor(model_file=bpe_path)


def clean(text):
    return " ".join(re.sub(r"[^\w' ]+", " ", text).split())


spellings = []
for index, text in enumerate([args.keyword, *args.variant]):
    pieces = sp.encode(clean(text).upper(), out_type=str) if clean(text) else []
    unknown = [p for p in pieces if p not in vocab]
    if pieces and not unknown:
        spellings.append(pieces)
        continue
    message = f"Cannot spell {text!r} with this model's tokens: {unknown or 'empty'}"
    if index == 0:
        emit(type="error", code="keyword_invalid", message=message)
        sys.exit(5)
    emit(type="warning", message=message)

label = "_".join(clean(args.keyword).lower().split())
fd, keywords_file = tempfile.mkstemp(prefix="notor-kws-", suffix=".txt")
with os.fdopen(fd, "w") as f:
    for spelled in spellings:
        f.write(f"{' '.join(spelled)} :{args.score} #{args.threshold} @{label}\n")

try:
    kws = sherpa_onnx.KeywordSpotter(
        tokens=tokens_path,
        encoder=pick("encoder"),
        decoder=pick("decoder"),
        joiner=pick("joiner"),
        keywords_file=keywords_file,
        num_threads=args.num_threads,
        keywords_score=args.score,
        keywords_threshold=args.threshold,
    )
except Exception as e:  # noqa: BLE001
    emit(type="error", code="failed", message=str(e))
    sys.exit(6)
finally:
    os.unlink(keywords_file)

stream = kws.create_stream()
emit(type="ready", version=sherpa_onnx.__version__, tokens=[" ".join(p) for p in spellings])

consumed = 0
leftover = b""
stdin = sys.stdin.buffer
while True:
    data = stdin.read1(8192)
    if not data:
        break
    data = leftover + data
    usable = len(data) - (len(data) % 2)
    leftover = data[usable:]
    if usable == 0:
        continue
    pcm = array.array("h", data[:usable])
    if sys.byteorder != "little":
        pcm.byteswap()
    samples = [s / 32768.0 for s in pcm]
    stream.accept_waveform(args.sample_rate, samples)
    consumed += len(samples)
    while kws.is_ready(stream):
        kws.decode_stream(stream)
        result = kws.get_result(stream)
        if result:
            emit(type="hit", keyword=result, endSample=consumed)
            kws.reset_stream(stream)
`;
