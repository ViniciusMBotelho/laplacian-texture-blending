import sys
import unittest
from pathlib import Path
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from validation_metrics import image_metrics


class QualityMetricsTests(unittest.TestCase):
    def setUp(self):
        self.ref=np.zeros((20,20,4),dtype=np.uint8)
        self.ref[...,3]=255

    def test_identity_and_strict_ssim_support(self):
        result=image_metrics(self.ref,self.ref)
        self.assertEqual(result['psnr_3d_db'],'Infinity')
        self.assertEqual(result['ssim_gpu'],1)
        self.assertEqual(result['ssim_valid_centers'],100)
        self.assertEqual(result['quality_terrain_pixels'],400)

    def test_known_rgb_mse(self):
        candidate=self.ref.copy();candidate[...,:3]=255
        result=image_metrics(candidate,self.ref)
        self.assertEqual(result['psnr_3d_db'],0)
        self.assertLess(result['ssim_gpu'],.001)

    def test_sky_pixels_are_excluded(self):
        ref=np.zeros((30,30,4),dtype=np.uint8);ref[5:25,5:25,3]=255
        cand=ref.copy();cand[:5,:,:3]=255
        result=image_metrics(cand,ref)
        self.assertEqual(result['psnr_3d_db'],'Infinity')
        self.assertEqual(result['ssim_gpu'],1)

    def test_different_masks_and_shapes_are_errors(self):
        candidate=self.ref.copy();candidate[0,0,3]=0
        with self.assertRaisesRegex(ValueError,'masks differ'):image_metrics(candidate,self.ref)
        with self.assertRaisesRegex(ValueError,'RGBA'):image_metrics(self.ref[:10],self.ref)

    def test_no_fallback_to_contaminated_edge_windows(self):
        ref=np.zeros((20,20,4),dtype=np.uint8);ref[9:11,9:11,3]=255
        with self.assertRaisesRegex(ValueError,'No valid SSIM'):image_metrics(ref,ref)
        with self.assertRaisesRegex(ValueError,'Empty terrain'):image_metrics(np.zeros_like(ref),np.zeros_like(ref))


if __name__=='__main__':unittest.main(verbosity=2)
