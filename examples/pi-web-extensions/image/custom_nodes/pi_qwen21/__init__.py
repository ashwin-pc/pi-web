"""Small isolated Qwen 2.1 helpers: 64-channel latent and upstream Viggle flow schedule."""
import math
import torch
import comfy.model_management
import nodes
from types import MethodType
from comfy.ldm.wan.vae2_2 import AvgDown3D

def mps_safe_avg_down(self, x):
    if x.device.type != 'mps':
        return self._pi_original_forward(x)
    # MPS F.pad corrupts large five-dimensional temporal padding tensors.
    # Explicit concatenation is numerically identical to upstream zero padding.
    pad_t = (self.factor_t - x.shape[2] % self.factor_t) % self.factor_t
    if pad_t:
        zeros = x.new_zeros(x.shape[0], x.shape[1], pad_t, x.shape[3], x.shape[4])
        x = torch.cat((zeros, x), dim=2)
    b, c, t, h, w = x.shape
    x = x.reshape(b, c, t // self.factor_t, self.factor_t,
                  h // self.factor_s, self.factor_s, w // self.factor_s, self.factor_s)
    x = x.permute(0, 1, 3, 5, 7, 2, 4, 6).contiguous()
    x = x.reshape(b, self.out_channels, self.group_size,
                  t // self.factor_t, h // self.factor_s, w // self.factor_s)
    return x.mean(dim=2)

class Qwen21VAELoader(nodes.VAELoader):
    def load_vae(self, vae_name):
        result = super().load_vae(vae_name)
        vae = result[0]
        if vae.latent_channels == 64 and vae.output_channels == 4:
            for module in vae.first_stage_model.modules():
                if isinstance(module, AvgDown3D):
                    module._pi_original_forward = module.forward
                    module.forward = MethodType(mps_safe_avg_down, module)
        return result

class Qwen21EmptyLatent:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"width": ("INT", {"default": 1024, "min": 256, "max": 2048, "step": 32}), "height": ("INT", {"default": 1024, "min": 256, "max": 2048, "step": 32})}}
    RETURN_TYPES = ("LATENT",)
    FUNCTION = "make"
    CATEGORY = "pi/qwen21"
    def make(self, width, height):
        return ({"samples": torch.zeros((1, 64, height // 16, width // 16), device=comfy.model_management.intermediate_device())},)

class ViggleFlowSigmas:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"width": ("INT", {"default": 1024, "min": 256, "max": 2048}), "height": ("INT", {"default": 1024, "min": 256, "max": 2048})}}
    RETURN_TYPES = ("SIGMAS",)
    FUNCTION = "make"
    CATEGORY = "pi/qwen21"
    def make(self, width, height):
        # Diffusers FlowMatchEulerDiscreteScheduler: use_dynamic_shifting=True,
        # base_image_seq_len=256, max_image_seq_len=8192, base_shift=.5,
        # max_shift=.9, time_shift_type=exponential, shift_terminal=None.
        sequence_length = (width // 16) * (height // 16) // 4
        mu = .5 + (.9 - .5) * (sequence_length - 256) / (8192 - 256)
        t = torch.linspace(1, .25, 4, dtype=torch.float32)
        sigmas = math.exp(mu) / (math.exp(mu) + (1 / t - 1))
        return (torch.cat((sigmas, torch.zeros(1))),)

NODE_CLASS_MAPPINGS = {"PiQwen21EmptyLatent": Qwen21EmptyLatent, "PiViggleFlowSigmas": ViggleFlowSigmas, "PiQwen21VAELoader": Qwen21VAELoader}
NODE_DISPLAY_NAME_MAPPINGS = {"PiQwen21EmptyLatent": "Qwen 2.1 empty latent", "PiViggleFlowSigmas": "Viggle dynamic flow sigmas"}
