Spoilaint speech model
======================

model.int8.onnx, tokens.txt: NVIDIA NeMo "stt_en_conformer_ctc_small" (English speech recognition,
Conformer-CTC, ~13M parameters), converted to ONNX and quantised to int8 by the sherpa-onnx project.

  Model:   https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/stt_en_conformer_ctc_small
  Licence: CC-BY-4.0 on NVIDIA NGC (https://creativecommons.org/licenses/by/4.0/), (c) NVIDIA;
           the sherpa-onnx conversion is published under Apache-2.0
  ONNX:    https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-ctc-en-conformer-small.tar.bz2

Spoilaint uses it only to find when each subtitle word is spoken (forced alignment). It runs entirely
on your computer; no audio leaves it. Unchanged from the sherpa-onnx release.
